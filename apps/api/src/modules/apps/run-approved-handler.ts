// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import { withPrivilegedDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { isRecord } from "~/lib/guards"
import { appsLogger as log } from "~/lib/logger"
import { callerSafeDbError, isTransientDbError } from "~/lib/transient-db-error"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { checkToolScopes } from "~/modules/agent/scopes/required-scopes"
import { setTaintFlag } from "~/modules/agent/scopes/taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { approvalReentryWriteScopes } from "~/modules/agent/scopes/write-required-scopes"
import {
  clearStaleTerminalFailure,
  EFFECT_LANDED_KEY,
  HandlerAmbiguousError,
  HandlerNoEffectError,
  hasLandedEffect,
  promoteLandedEffect,
  readHandlerExecution,
} from "~/modules/approvals/handler-protocol"
import { toolRegistry } from "~/modules/apps/app-registries"
import {
  executeApprovedToolHandlerInternal,
  type ToolOrigin,
  validateToolResult,
} from "~/modules/apps/execute-tool"
import { withAppDimensionAliases } from "~/modules/apps/runtime-helpers"
import { isDemoEgressRestricted, isDemoRestriction } from "~/modules/demo/demo-egress"
import { filterResponse, returnsDimensionDefs } from "~/modules/permissions/response-filter"

// Match handler-protocol.ts's kernel schema ref verbatim.
const K = drizzleSql.raw(schemaRef("kernel"))

export class RequesterLostScopeError extends Error {
  code = "requester_lost_scope"
  constructor(
    public toolName: string,
    public requiredScope: string,
  ) {
    super(
      `neither the requester nor the approver holds scope ${requiredScope} for tool ${toolName}`,
    )
  }
}

export class HandlerToolMissingError extends Error {
  code = "handler_tool_missing"
  constructor(public toolName: string) {
    super(`tool ${toolName} not registered`)
  }
}

/**
 * APPROVAL IS DELEGATION. A human who approves a request lends it their own authority: the
 * action then runs with everything the requester OR the decider may do. Identity never moves
 * (rows stay created by / owned by / attributed to the requester, and every check keyed on a
 * user id still sees the requester), only scopes and dimension grants widen. This is the single
 * place the rule lives, so no handler, service or RLS policy needs to know approvals exist:
 * each keeps asking "may this actor do it" and gets the answer a reviewing human expects.
 *
 * Without it an admin approving a teammate's draft watched it fail on the teammate's missing
 * grant, a refusal no approver could ever clear because the approver was never consulted.
 *
 * Checks that deliberately ignore wildcard authority (literal scope membership, owner-only
 * rules) are untouched: a decider's `*` is still not the literal scope, and is still not the owner.
 */
export function delegateDeciderAuthority(
  requesterContext: UserContext,
  deciderContext: UserContext | undefined,
): UserContext {
  if (!deciderContext || deciderContext.userId === requesterContext.userId) return requesterContext
  if (deciderContext.orgId !== requesterContext.orgId) return requesterContext
  const dimensionGrants: Record<string, string[]> = {}
  for (const grants of [requesterContext.dimensionGrants, deciderContext.dimensionGrants]) {
    for (const [key, values] of Object.entries(grants ?? {})) {
      dimensionGrants[key] = Array.from(new Set([...(dimensionGrants[key] ?? []), ...values]))
    }
  }
  return {
    ...requesterContext,
    scopes: Array.from(new Set([...requesterContext.scopes, ...deciderContext.scopes])),
    dimensionGrants,
  }
}

/**
 * The actor an approved handler EXECUTES under: the requester, carrying the decider's delegated
 * authority (see delegateDeciderAuthority), aliased for the TARGET app so the app's own
 * RLS-protected infrastructure (e.g. shopify `install_metadata`, rlsScope:"internal") is
 * visible, exactly the `actorForRls` the direct tool path uses. The alias is data-visibility
 * only, never an auth grant. Without it a gated write approved by a non-admin failed closed with
 * "install_metadata row not found", and app-dimension-gated writes missed their mirrored
 * `<app>:<key>` grants.
 */
export function approvalExecutionActor(
  requesterContext: UserContext,
  toolName: string,
  deciderContext?: UserContext,
): ActorContext {
  const colonIdx = toolName.indexOf(":")
  const appName = colonIdx === -1 ? toolName : toolName.slice(0, colonIdx)
  return withAppDimensionAliases(
    delegateDeciderAuthority(requesterContext, deciderContext),
    appName,
  )
}

export interface RunApprovedToolHandlerArgs {
  orgId: string
  requesterContext: UserContext
  deciderId: string
  /** The approving human's effective permissions, loaded fresh at decide time. Their authority
   *  is delegated to the execution (see delegateDeciderAuthority). Absent means no delegation:
   *  the action runs on the requester's authority alone. */
  deciderContext?: UserContext
  /** The routine this approval ORIGINATED from, captured at request time. A
   *  routine runs as its owner, so without this the send is attributed in-app to
   *  whoever created the routine. Absent for a human-initiated request. */
  originRoutineId?: string
  toolName: string // canonical "app:tool"
  payload: unknown
  approvalRequestId: string
  threadId: string
  /** Originating surface recorded on the approval (spec C7). MCP-originated
   *  approvals stamp the decided mutation actorType:"mcp". Can also be
   *  "human-ui" (a genuine direct human request that itself got gated) or
   *  "system" (webhook/job/routine, no re-entrant origin) -- see
   *  execute-tool.ts ToolOrigin. */
  origin?: ToolOrigin
  /**
   * FX4: `approval_requests.proposing_turn_scopes` -- the scopes the turn that
   * PROPOSED this gated call had accumulated. Typed `unknown` on purpose: it
   * comes straight off a database row, and deciding what an unreadable value
   * means is `approvalReentryWriteScopes`'s job, not a cast's. `null` means
   * nothing was recorded (a pre-0067 approval, or an unknowable turn).
   */
  proposingTurnScopes?: unknown
  /**
   * A11: `approval_requests.agent_id` -- the agent whose turn PROPOSED this
   * gated call, persisted at request time and read straight off the row here.
   *
   * Deliberately NOT re-resolved at re-entry: this runs in another request,
   * minutes or days later, and asking "who would act now" can name a DIFFERENT
   * agent than the one that actually proposed the call (or a human's own
   * request, which has no agent at all). `null` means nothing was recorded (an
   * approval created before the column was written, or a turn with no agent),
   * and the re-entry then records no agent rather than guessing one.
   */
  agentId?: string | null
  /**
   * The sub-run that proposed the call (`metadata.originRun`, validated by
   * `parseOriginRun`), so a sub-agent the approved handler spawns nests below it
   * instead of restarting at depth 0. Absent for anything a sub-run did not propose.
   */
  originRun?: { runId: string; rootRunId: string; nestingDepth: number }
}

export async function runApprovedToolHandler(args: RunApprovedToolHandlerArgs): Promise<unknown> {
  const colonIdx = args.toolName.indexOf(":")
  if (colonIdx === -1) throw new HTTPException(400, { message: "Invalid tool name format" })
  const appName = args.toolName.slice(0, colonIdx)
  const toolShort = args.toolName.slice(colonIdx + 1)

  const tool = toolRegistry.get([args.orgId, appName, toolShort])
  if (!tool) throw new HandlerToolMissingError(args.toolName)

  // Authorization is checked on RAW scopes (the alias below is data-visibility only, never an
  // authorization grant): the requester must still hold the tool's scope, or the approving human
  // must hold it themselves and so lends it.
  // The tool's resolved scope set, the rule every other path applies: a tool
  // that declares `requiredScopes` has no single `scope`, and checking that
  // field alone refused every approval of such a tool, whoever approved it.
  const authority = delegateDeciderAuthority(args.requesterContext, args.deciderContext)
  const scopeCheck = checkToolScopes(tool, authority.scopes)
  if (!scopeCheck.authorized) {
    throw new RequesterLostScopeError(
      args.toolName,
      (scopeCheck.missing.length > 0 ? scopeCheck.missing : scopeCheck.required).join(", ") ||
        "(none declared)",
    )
  }

  // FX4 — D5 write inheritance across the approval wait. THIS execution is the
  // write the proposing turn was not allowed to make inline: the human clicked
  // Approve in another request, minutes or days later, so the proposing turn's
  // AsyncLocalStorage frame is long gone and every scope-tagged sink the
  // handler touches (kernel.messages, kernel.agent_memory,
  // app_knowledge.documents) saw NO frame and tagged its row `{}` -- the empty
  // positive assertion that means "nothing scoped was read", which publishes
  // the row to every member of the room. Approving a gated call must not widen
  // visibility beyond what the same call would have had inline.
  //
  // So the scopes recorded on the approval row are seeded back into a run frame
  // that wraps the whole re-entry. Everything downstream then behaves exactly as
  // it did in the proposing turn without knowing anything about approvals: the
  // sandbox bridge's captures (spawn + write parent frames, taken at bridge
  // construction, which happens inside this frame) see the turn, and host-side
  // handlers reading `currentTurnWriteScopes` see it too.
  //
  // It is an ACCUMULATOR, not a fixed list, because the re-entry may read more
  // than the proposing turn did: anything it records unions in, and a knowledge
  // update unions on top of the existing tag. The tag never narrows.
  //
  // Resolved BEFORE anything runs: a refusal here means the handler never
  // executes, so a re-entry that cannot know its scopes writes nothing at all
  // rather than writing it untagged.
  const reentryWriteScopes = approvalReentryWriteScopes(
    args.proposingTurnScopes,
    args.requesterContext.scopes,
  )
  const reentryScopeAccumulator = createTurnScopeAccumulator({ orgId: args.orgId })
  reentryScopeAccumulator.recordInjected(reentryWriteScopes)
  // Deliberately minimal: the run identity fields carry the APPROVAL's id (there
  // is no agent run here -- the turn that proposed this ended long ago), and no
  // routineId, so the routine-attribution path keeps reading the approval's own
  // recorded `originRoutineId` exactly as before.
  //
  // A11 -- the ACTING AGENT is seeded the same way the scopes above are, and
  // from the same place: the value PERSISTED on the approval row when the call
  // was proposed. Without it every write this re-entry makes (the messages it
  // posts, the documents it files, the events it queues) audited with no agent,
  // so "what did the logistics agent do" missed exactly the actions a human
  // stopped to approve. Everything downstream reads it through
  // `captureActingAgentId()` and the bridge's captured frame, knowing nothing
  // about approvals.
  //
  // Depth: a call a SUB-RUN proposed re-enters as that run (its id, root and
  // depth), so a sub-agent the handler spawns nests below it exactly as it would
  // have in the proposing turn; MAX_NESTING_DEPTH holds across the approval.
  const reentryFrame: RunContext = {
    runId: args.originRun?.runId ?? args.approvalRequestId,
    parentRunId: null,
    rootRunId: args.originRun?.rootRunId ?? args.approvalRequestId,
    nestingDepth: args.originRun?.nestingDepth ?? 0,
    turnScopeAccumulator: reentryScopeAccumulator,
    ...(args.agentId ? { agentId: args.agentId } : {}),
  }

  // EXECUTE under the app-aliased actor — the SAME RLS context the direct tool path uses
  // (execute-tool's `actorForRls`); see approvalExecutionActor above.
  const executionActor = approvalExecutionActor(
    args.requesterContext,
    args.toolName,
    args.deciderContext,
  )

  // One id per DECIDE execution, stable across BL-180 in-handler transient retries (the
  // context object is built once) but fresh on every re-approval. Handlers that derive an
  // external idempotency key from tool params fold this in, so a FAILED execution's key
  // never poisons the next human approval of the same payload (the Shopify @idempotent
  // replay wedged a refund exactly this way), while a retry of the SAME execution still
  // dedupes.
  const approvalExecutionId = crypto.randomUUID()

  // A previous attempt's terminal failure must not outlive its retry: the
  // outcome reader treats a leftover failed_no_effect/ambiguous row as THIS
  // attempt's result, so a successful retry re-threw the old error and the
  // request stayed pending forever (prod 2026-08-06). Crash markers ('started')
  // and real successes are untouched. See clearStaleTerminalFailure.
  await withPrivilegedDb(args.orgId, "approval-clear-stale-failure", (tx) =>
    clearStaleTerminalFailure(
      tx,
      {
        orgId: args.orgId,
        approvalRequestId: args.approvalRequestId,
        approvalDeciderId: args.deciderId,
        toolName: args.toolName,
      },
      args.toolName,
    ),
  )

  let result: unknown
  let originalError: unknown
  try {
    result = await runContextStore.run(reentryFrame, () =>
      withRlsContext(executionActor, async (tx) => {
        return executeApprovedToolHandlerInternal({
          tool,
          orgId: args.orgId,
          userId: args.requesterContext.userId,
          actorScopes: executionActor.scopes ?? authority.scopes,
          tx,
          payload: args.payload,
          approvalContext: {
            approvalRequestId: args.approvalRequestId,
            approvalDeciderId: args.deciderId,
            originRoutineId: args.originRoutineId,
            toolName: args.toolName,
            approvalExecutionId,
          },
          origin: args.origin,
          // Forward the app-aliased execution actor (with the requester's dimension
          // grants) so a nested cross-app `ctx.executeTool` inside the approved
          // handler inherits the real dimensions — without it the sandbox bridge
          // defaults to empty dimension grants and a gated invoicing send →
          // mail:compose fails closed on the dimension-gated org mailbox ([[BL-186]]).
          actor: executionActor,
          // Forward the originating thread so a NESTED gated cross-app call made
          // inside this approved handler (undeclared target, or a declared one
          // that still gates for some other reason) can park its own approval
          // instead of throwing "threadId required" and wedging THIS approval
          // back to pending (decide.ts revertToPending).
          threadId: args.threadId,
        })
      }),
    )
  } catch (err) {
    originalError = err
  }

  // AN APPROVED READ ANSWERS WITH ITS ERROR (see `answersWithItsError`). A read
  // that threw ran and failed: the page was missing, the record not found. That
  // failure is the call's answer, handed to the agent as its result below, never
  // a reason to re-pend the request: approving it again only reruns the same
  // read (a guessed URL fetched once per approve, in a loop). The one exception
  // is a transient failure of our own database (a deadlock, a serialization
  // failure, a dropped connection), which rolled back before the read
  // completed: approving again can succeed, so it keeps the revert below.
  const readsOnly = answersWithItsError(tool)
  if (readsOnly && originalError !== undefined && !isTransientDbError(originalError)) {
    log.warn(
      { err: originalError, approvalRequestId: args.approvalRequestId, tool: args.toolName },
      "Approved read threw: its error is returned to the agent as the call's result",
    )
    result = { error: { code: "read_failed", message: handlerErrorMessage(originalError) } }
    originalError = undefined
  }

  // Manifest handlers cross the QuickJS boundary which may rethrow bridge failures
  // as plain Error(message). Trust the durable protocol row, not instanceof checks.
  const landed = await throwPersistedHandlerOutcome(
    args.orgId,
    args.approvalRequestId,
    args.toolName,
    originalError,
    args.deciderId,
    tool.approvalImpact,
  )
  // The external effect landed and the handler was cut off (or failed) after it,
  // in its post-effect work. The row is now `succeeded` with the provider's ref as
  // its result: the approval terminalizes as executed, and nothing is re-run.
  // Post-effect bookkeeping the handler did not finish is the app's own sync's
  // to catch up (mail ingests the sent message from the provider).
  if (landed) {
    log.warn(
      {
        err: originalError,
        approvalRequestId: args.approvalRequestId,
        tool: args.toolName,
        externalRef: landed,
      },
      "Approved handler did not finish after its external effect landed; recorded as succeeded from the landed ref",
    )
    return landed
  }
  if (originalError) throw originalError

  // SOFT-ERROR ENVELOPES ARE FAILURES. Handlers signal expected, caller-fixable
  // failures by RETURNING `{ error: { code, message } }` instead of throwing —
  // on the direct agent path that envelope surfaces as a failed tool call. On
  // the approved path, persisting it as 'succeeded' is a FALSE SUCCESS: the
  // approval card announces "executed successfully", a dependent @ref step then
  // dies on "missing output <key>" (the result holds only `error`), and the
  // bundle cancels with an unactionable ref message while the audit trail
  // claims the action ran (observed: boxtal create_shipment returning
  // unresolved_lines — the label was never bought, the chain died blind).
  // Record the failure and throw so the cascade fails the bundle with the REAL
  // reason, which the re-invoked agent can act on.
  //
  // A plain string (`{ error: "app not installed" }`) is the same failure in
  // its older shape, the one the agent path reads as a failed call too.
  //
  // A READ is the exception (`answersWithItsError`): its envelope (an HTTP 404
  // from the fetched site, a record not found) is what the call returned. It is
  // recorded as the execution's result and handed to the agent, which can try
  // something else; nothing is reverted, so nothing is left to approve again.
  //
  // A `final` refusal is not that answer on a read either: it says the call cannot
  // pass (a feature switched off while it waited), so the read closes like a write
  // and never reads as a tool that ran and returned an error.
  const softError = softErrorOf(result)
  if (softError && (!readsOnly || softError.final === true)) {
    const code = typeof softError.code === "string" ? softError.code : "tool_error"
    const message =
      typeof softError.message === "string" ? softError.message : "handler returned an error"
    // Optional handler-supplied payload patch: applied by decide's revertToPending
    // so the re-staged (reverted) approval reflects reality — e.g. a
    // price_increased failure re-stages the card at the NEW quoted price instead
    // of the stale one the failed buy was approved at.
    const restagePatch =
      softError.restage_payload_patch &&
      typeof softError.restage_payload_patch === "object" &&
      !Array.isArray(softError.restage_payload_patch)
        ? (softError.restage_payload_patch as Record<string, unknown>)
        : undefined
    log.warn(
      { approvalRequestId: args.approvalRequestId, tool: args.toolName, code, message },
      "Approved handler returned a soft-error envelope — recording as failed, not succeeded",
    )
    // UPSERT — not recordFailedNoEffect's bare UPDATE: handlers that return
    // envelopes (the real invoicing/boxtal mutation handlers) do not self-record
    // the protocol, so no row exists yet and an UPDATE would no-op, leaving no
    // durable trace of the failure. Mirrors the succeeded-path persist below.
    await withPrivilegedDb(args.orgId, "approval-soft-error-record", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO ${K}.approved_handler_executions
          (org_id, approval_request_id, tool_name, status, actor_id, attempts, last_attempt_at, finished_at, error)
        VALUES (${args.orgId}, ${args.approvalRequestId}, ${args.toolName}, 'failed_no_effect', ${args.deciderId}, 1, now(), now(), ${JSON.stringify({ code, message })}::jsonb)
        ON CONFLICT (approval_request_id, tool_name) DO UPDATE
          SET status = 'failed_no_effect',
              error = EXCLUDED.error,
              finished_at = now()
          WHERE NOT COALESCE(${K}.approved_handler_executions.external_ref ? ${EFFECT_LANDED_KEY}, false)
      `),
    )
    // The protocol's typed no-effect error — decide maps it to handler_failed
    // (422), reverts the request to pending for a post-fix re-approve, and the
    // bundle cascade fails dependents with THIS message as the reason.
    // `final: true` marks a refusal no re-approval of the same payload can
    // pass (the plan or preview the approval bound has changed): decide then
    // closes the request instead of re-pending it.
    throw new HandlerNoEffectError(args.toolName, {
      code,
      message,
      ...(restagePatch ? { restage_payload_patch: restagePatch } : {}),
      ...(softError.final === true ? { final: true } : {}),
    })
  }

  // Persist the decided result for liaison_approval_status pull (Phase 12, C7) AND for the agent
  // conductor's gated-write outcome surfacing (it reads GET /api/approvals/:id/result →
  // readDecidedResult, keyed on status='succeeded'). Keyed by (approvalRequestId, toolName).
  //
  // UPSERT — not a bare UPDATE: a self-recording handler (test app, tickets — calls
  // ctx.approval_recordSucceeded) already wrote a 'succeeded' row, so DO UPDATE sets its result. But
  // the real shopify/invoicing mutation handlers do NOT self-record the protocol — they just run the
  // mutation and return — so NO 'succeeded' row exists, and a bare UPDATE no-ops, leaving the decided
  // result null (the agent then never learns its created entity and re-creates/deletes — the
  // gated-write-class-wide flailing). The INSERT path durably records the succeeded execution + its
  // result for those handlers. The `WHERE status='succeeded'` on DO UPDATE preserves an
  // 'awaiting_output' row (async-outcome handlers — their result lands later via poll-output), and
  // never clobbers a non-succeeded state.
  //
  // INVARIANT: the handler side-effect has ALREADY committed at this point. A failure to persist the
  // result must NOT propagate as a handler failure (that would be a false negative — the mutation
  // ran). Log loudly and continue; the pull degrades to approved-without-result, never to a phantom
  // failure.
  try {
    await withPrivilegedDb(args.orgId, "approval-persist-decided-result", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO ${K}.approved_handler_executions
          (org_id, approval_request_id, tool_name, status, actor_id, attempts, last_attempt_at, finished_at, result)
        VALUES (${args.orgId}, ${args.approvalRequestId}, ${args.toolName}, 'succeeded', ${args.deciderId}, 1, now(), now(), ${JSON.stringify(result ?? null)}::jsonb)
        ON CONFLICT (approval_request_id, tool_name) DO UPDATE
          SET result = EXCLUDED.result
          WHERE ${K}.approved_handler_executions.status = 'succeeded'
      `),
    )
  } catch (persistErr) {
    log.error(
      { err: persistErr, approvalRequestId: args.approvalRequestId, tool: args.toolName },
      "decided-result persist failed AFTER successful handler execution — result unavailable for pull, but the action ran (not a handler failure)",
    )
  }

  // A read's error envelope is its answer, returned as is: it carries no output
  // to validate against the tool's schema or to filter by dimension.
  if (softError) {
    log.warn(
      { approvalRequestId: args.approvalRequestId, tool: args.toolName, error: softError },
      "Approved read returned an error: recorded as its result and returned to the agent",
    )
    return result
  }

  if (tool.returns?.schema && result) {
    if (!validateToolResult(result, tool.returns.schema)) {
      log.error({ tool: args.toolName }, "Approved handler output validation failed")
      throw new HTTPException(500, { message: "Tool execution failed" })
    }
  }

  if (tool.taintSource && args.threadId) {
    try {
      await setTaintFlag(args.threadId, args.orgId)
    } catch (err) {
      log.error({ err }, "Failed to set taint flag after approved handler")
    }
  }

  if (tool.returns?.dimensions && result) {
    const grants = args.requesterContext.dimensionGrants
    const defs = returnsDimensionDefs(args.orgId, tool.appName, tool.returns.dimensions)
    return filterResponse(result, tool.returns.dimensions, grants, defs)
  }

  return result
}

/**
 * Classify the handler's outcome from its durable protocol row, throwing the
 * typed failure. Returns the landed external ref (now the decided result) when
 * the handler recorded its external effect (`recordEffectLanded`) but did not
 * reach `recordSucceeded`; returns undefined for an ordinary success.
 */
async function throwPersistedHandlerOutcome(
  orgId: string,
  approvalRequestId: string,
  toolName: string,
  originalError: unknown,
  deciderId: string,
  approvalImpact?: "external" | "internal",
): Promise<Record<string, unknown> | undefined> {
  const row = await readHandlerExecution(orgId, approvalRequestId, toolName)

  // THE EFFECT LANDED, the handler did not finish. A handler cut off by the
  // sandbox ceiling, or failing, AFTER its provider call returned left `started`
  // (or its own catch wrote `ambiguous`). The landed ref proves the effect
  // happened, so this is a success, never "unknown": promote it.
  if (
    (row?.status === "started" || row?.status === "ambiguous") &&
    hasLandedEffect(row.externalRef)
  ) {
    const promoted = await withPrivilegedDb(orgId, "approval-promote-landed-effect", (tx) =>
      promoteLandedEffect(tx, approvalRequestId, toolName),
    )
    if (promoted) return promoted
  }

  if (row?.status === "failed_no_effect") {
    throw new HandlerNoEffectError(toolName, row.error ?? originalError)
  }

  // A REFUSAL THAT FIRED BEFORE THE EFFECT is a definite failure, whatever the
  // handler recorded. Two cases, both known before anything left the box:
  //
  //   * the error IS a demo refusal (`DEMO_RESTRICTED`): the egress door threw
  //     it instead of putting the request on the wire;
  //   * the org is a demo org on a demo instance and the handler failed: every
  //     outbound door is closed for it (mail refused, app egress refused or
  //     answered from fixtures), so no external outcome can be unknown. The
  //     Shopify fixture store answers a blocked write with a GraphQL error the
  //     app rethrows as its own, which carries no demo code by then.
  //
  // Without this, an external-impact handler (mail sends, Shopify writes) that
  // was refused recorded `ambiguous` or threw with no row, and the approval
  // parked at `approving` for operator reconciliation that a demo visitor can
  // never do: the card read "Stalled" over a message that said, correctly,
  // nothing had been sent. Outside a demo org a genuinely unknown outcome (a
  // timeout after the send went out) stays ambiguous.
  const failed = originalError !== undefined || row?.status === "ambiguous"
  if (
    failed &&
    row?.status !== "succeeded" &&
    row?.status !== "awaiting_output" &&
    (isDemoRestriction(originalError) ||
      isDemoRestriction(row?.error) ||
      (await isDemoEgressRestricted(orgId)))
  ) {
    const recorded = isRecord(row?.error) ? row.error : null
    const errPayload = {
      code: typeof recorded?.code === "string" ? recorded.code : demoCodeOf(originalError),
      message:
        typeof recorded?.message === "string"
          ? recorded.message
          : originalError !== undefined
            ? handlerErrorMessage(originalError)
            : "the action was refused before it took effect",
    }
    await recordNoEffect(orgId, approvalRequestId, toolName, deciderId, errPayload)
    throw new HandlerNoEffectError(toolName, errPayload)
  }

  if (row?.status === "ambiguous") {
    throw new HandlerAmbiguousError(toolName, row.error ?? originalError)
  }
  // `awaiting_output` is a valid non-terminal outcome — the human-approved action
  // committed; only async output retrieval is pending. The cascade engine parks
  // the step behind a poll job; it is NOT a handler failure.
  if (row?.status === "succeeded" || row?.status === "awaiting_output") return

  // No protocol row AND the handler returned cleanly → synchronous success.
  // The handler-protocol (`ctx.approval_record*`) exists to disambiguate handlers
  // whose side effects land OUTSIDE the kernel tx (e.g. mail sending an email):
  // a crash mid-effect leaves a `started` row so we don't double-send. A purely
  // synchronous handler (DB-only, like the invoicing issuance path) commits all
  // of its effects inside the handler tx — a clean return is proof the tx
  // committed, so it never needs to record. Treat it as succeeded.
  // (A non-null non-terminal row, e.g. `started`, still means genuinely unknown;
  // and a clean miss WITH an error is handled by the throw below.)
  if (!row && originalError === undefined) return

  if (originalError !== undefined) {
    log.error({ err: originalError, approvalRequestId, tool: toolName }, "approved handler threw")
  }

  // No protocol row AND the handler THREW. The mirror of the clean-return case
  // above: a handler whose effects all land inside the kernel tx cannot have
  // left one behind when that tx rolled back. Whether that reasoning holds is
  // not a guess -- the tool DECLARES it as `approvalImpact`, and the protocol
  // (`ctx.approval_record*`) exists precisely for the handlers that reach
  // outside it, which record `started` BEFORE the effect. So:
  //
  //   internal impact + no protocol row + threw  ->  provably NO effect
  //   external impact + no protocol row + threw  ->  genuinely unknown
  //
  // This used to return AMBIGUOUS for both, and ambiguous is a one-way door:
  // healWedgedApproving refuses to heal it, the reaper refuses to heal it, and
  // every later Approve/Reject 409s `already_decided`. So an ordinary
  // deterministic failure of a DB-only tool -- a 403 from a sensitivity grant, a
  // collection id passed as a name so the uuid cast threw -- parked its approval
  // at `approving` FOREVER with no operator path out. Three rows on prod
  // (2026-08-05/25/27), two of them plain input/permission errors that touched
  // nothing (ticket-10197 / ticket-10200).
  //
  // A no-effect classification is safe AND strictly better here: decide reverts
  // the row to pending, surfaces the real cause on the card, and the operator can
  // fix the input and re-approve.
  if (!row && approvalImpact !== "external") {
    // Record the outcome durably first, so the row is recoverable by the reaper
    // even if this process dies before decide reverts it. Mirrors the
    // soft-error UPSERT above (no row exists yet, so a bare UPDATE would no-op).
    const errPayload = {
      code: "handler_threw_no_effect",
      message: handlerErrorMessage(originalError),
    }
    await recordNoEffect(orgId, approvalRequestId, toolName, deciderId, errPayload)
    throw new HandlerNoEffectError(toolName, errPayload)
  }

  const unknown = {
    code: "handler_outcome_unknown",
    status: row?.status ?? "missing",
    ...(originalError !== undefined ? { message: handlerErrorMessage(originalError) } : {}),
  }
  // A `started` row with no landed effect is a handler cut off (or returning)
  // between `recordStarted` and its outcome. Settle it as `ambiguous` with the
  // error, so the row says what happened instead of reading as still running.
  if (row?.status === "started")
    await recordStartedAsAmbiguous(orgId, approvalRequestId, toolName, unknown)
  throw new HandlerAmbiguousError(toolName, unknown)
}

/**
 * `started` -> `ambiguous`, only while the row is still `started` and carries no
 * landed effect (a landed ref that raced in is promoted, never downgraded).
 */
async function recordStartedAsAmbiguous(
  orgId: string,
  approvalRequestId: string,
  toolName: string,
  errPayload: Record<string, unknown>,
): Promise<void> {
  try {
    await withPrivilegedDb(orgId, "approval-started-to-ambiguous", (tx) =>
      tx.execute(drizzleSql`
        UPDATE ${K}.approved_handler_executions
        SET status = 'ambiguous',
            error = ${JSON.stringify(errPayload)}::jsonb,
            finished_at = now()
        WHERE approval_request_id = ${approvalRequestId} AND tool_name = ${toolName}
          AND status = 'started'
          AND NOT COALESCE(external_ref ? ${EFFECT_LANDED_KEY}, false)
      `),
    )
  } catch (persistErr) {
    log.error(
      { err: persistErr, approvalRequestId, tool: toolName },
      "failed to settle a started handler row as ambiguous; it stays started",
    )
  }
}

function demoCodeOf(err: unknown): string {
  return isDemoRestriction(err) ? "DEMO_RESTRICTED" : "handler_threw_no_effect"
}

/**
 * Record a no-effect outcome durably, so the row is recoverable by the reaper
 * even if this process dies before decide reverts it. An UPSERT: a handler
 * that never self-recorded has no row yet, and one that recorded `started` or
 * `ambiguous` is overwritten with the definite outcome.
 */
async function recordNoEffect(
  orgId: string,
  approvalRequestId: string,
  toolName: string,
  deciderId: string,
  errPayload: { code: string; message: string },
): Promise<void> {
  try {
    await withPrivilegedDb(orgId, "approval-threw-no-effect-record", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO ${K}.approved_handler_executions
          (org_id, approval_request_id, tool_name, status, actor_id, attempts, last_attempt_at, finished_at, error)
        VALUES (${orgId}, ${approvalRequestId}, ${toolName}, 'failed_no_effect', ${deciderId}, 1, now(), now(), ${JSON.stringify(errPayload)}::jsonb)
        ON CONFLICT (approval_request_id, tool_name) DO UPDATE
          SET status = 'failed_no_effect',
              error = EXCLUDED.error,
              finished_at = now()
          WHERE NOT COALESCE(${K}.approved_handler_executions.external_ref ? ${EFFECT_LANDED_KEY}, false)
      `),
    )
  } catch (persistErr) {
    // Losing the durable trace must not turn a no-effect failure back into a
    // permanent park: decide's revert is the primary recovery, this is backup.
    log.error(
      { err: persistErr, approvalRequestId, tool: toolName },
      "failed to record no-effect handler outcome; decide will still revert the request",
    )
  }
}

/**
 * The message an approval card shows for a handler that threw. A DB error's own
 * message is Drizzle's `Failed query: <sql>\nparams: <values>`, which leaks the
 * schema and every bound value into the toast, so it becomes the caller-safe
 * text plus the server's own reason; the full error is logged by the caller.
 */
export function handlerErrorMessage(err: unknown): string {
  const safe = callerSafeDbError(err)
  if (safe)
    return safe.facts.message ? `${safe.message} Reason: ${safe.facts.message}` : safe.message
  return err instanceof Error ? err.message : String(err)
}

/** A handler's error envelope (`{ error: { code, message } }`, or the older
 *  `{ error: "text" }`), or null when the result is not one. */
export function softErrorOf(result: unknown): {
  code?: unknown
  message?: unknown
  restage_payload_patch?: unknown
  final?: unknown
} | null {
  const raw = (result as { error?: unknown } | null)?.error
  const envelope: {
    code?: unknown
    message?: unknown
    restage_payload_patch?: unknown
    final?: unknown
  } | null =
    typeof raw === "string" && raw.length > 0
      ? { message: raw }
      : typeof raw === "object" && raw !== null
        ? raw
        : null
  if (!envelope) return null
  return typeof envelope.code === "string" || typeof envelope.message === "string" ? envelope : null
}

/**
 * True for a tool whose approved execution answers the agent with its error
 * instead of re-pending the request: a READ, with no effect to protect or to
 * repeat. That is a tool declared `readOnly` (writes no table, no side effect),
 * or one that only reads the public web (`outboundWebRead`: web_fetch,
 * web_search, whose one way out is the request it sends), and that declares no
 * `writesToTable`. Once such a call ran, its failure (a 404 from the site, a
 * record not found) is its result: approving the same call again only repeats
 * it. A write keeps the revert, whose re-approval is the intended retry path
 * (a payload edit, a `restage_payload_patch`; a `final` failure closes it).
 */
export function answersWithItsError(tool: {
  readOnly?: boolean
  outboundWebRead?: boolean
  writesToTable?: string
}): boolean {
  if (tool.writesToTable !== undefined) return false
  return tool.readOnly === true || tool.outboundWebRead === true
}
