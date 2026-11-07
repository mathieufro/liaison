// SPDX-License-Identifier: FSL-1.1-ALv2

import { isOutboundOp } from "@liaison/app-sdk/contracts"
import {
  type ApprovalRequestStatus,
  type ApprovalSummary,
  approvalSummarySchema,
  buildRefToken,
  type FoundRef,
  findRefTokens,
} from "@liaison/shared"
import type { SchemaObject } from "ajv"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { ActorContext, RlsSession } from "~/db/rls"
import { createRlsSession, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { logFailure } from "~/lib/failure-severity"
import { nextApprovalHandle } from "~/lib/handle"
import { appsLogger as log } from "~/lib/logger"
import {
  callerSafeDbError,
  describeDbError,
  isTransientDbError,
  pgErrorFacts,
  retryOnTransientDbError,
} from "~/lib/transient-db-error"
import { checkReadOnlyRun, isReadOnlyTool } from "~/modules/agent/runtime/read-only-run"
import { captureReadOnlyRun } from "~/modules/agent/runtime/run-context"
import { alreadyPendingMessage } from "~/modules/approvals/already-pending"
import {
  type ApprovalPolicyDecision,
  composeGate,
  evaluateApprovalPolicy,
} from "~/modules/approvals/approval-policy"
import { evaluateAutoApprove } from "~/modules/approvals/auto-approve"
import {
  appCrossAppCallsRegistry,
  appDependenciesRegistry,
  isManifestHandler,
  type ManifestHandlerRef,
  toolRegistry,
} from "~/modules/apps/app-registries"
import type { BulkToolMeta } from "~/modules/apps/bulk-agent-tools"
import {
  CONNECTION_CREDENTIALS_MISSING,
  ConnectionCredentialsMissingError,
} from "~/modules/apps/connections/credentials-missing"
import { createAppContext } from "~/modules/apps/context"
import { validateParamsForTool } from "~/modules/apps/execute-tool-params"
import { mintExecutionToken } from "~/modules/apps/execution-token"
import {
  finalizeIdempotency,
  invalidateIdempotency,
  reserveIdempotency,
} from "~/modules/apps/idempotency"
import {
  ORIGINATING_APPROVAL_TOOLS,
  verifyOriginatingApproval,
} from "~/modules/apps/originating-approval"
import { outboundPlaceholderRefusal } from "~/modules/apps/outbound-placeholder-refusal"
import { createDefaultFillerCache } from "~/modules/apps/param-validator"
import {
  type ContractFileTarget,
  contractFileTargetOptions,
} from "~/modules/apps/provider-contracts/file-target"
import { verifyContractGrant } from "~/modules/apps/provider-contracts/grant"
import { isDeclaredContractDispatch } from "~/modules/apps/provider-contracts/resolve"
import {
  findMalformedRefs,
  malformedRefMessage,
  personSequencedMessage,
  refNotChainableMessage,
  refNotFoundMessage,
  refSpanMessage,
  refUnknownOutputMessage,
  sequencingHint,
} from "~/modules/apps/ref-messages"
import { withAppDimensionAliases } from "~/modules/apps/runtime-helpers"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { resolveToolTimeoutMs } from "~/modules/apps/sandbox/executor"
import {
  createSandboxRpcBridge,
  createSessionRpcBridge,
  inlinePgCauseOnBridge,
} from "~/modules/apps/sandbox/rpc-bridge"
import { runApp } from "~/modules/apps/sandbox/run-app"
import {
  attachUpstreamTrace,
  type UpstreamTrace,
  upstreamFailureMessage,
  upstreamFailureOf,
} from "~/modules/apps/sandbox/upstream-trace"
import {
  type ExecPriority,
  SANDBOX_TENANT_BUSY_CODE,
  SANDBOX_TENANT_RETRY_AFTER_SECONDS,
  SandboxTenantBusyError,
} from "~/modules/apps/sandbox/worker-pool"
import { APP_TOOL_ERROR_STATUS } from "~/modules/apps/tool-error-status"
import {
  addressGroundingRefusal,
  legalIdentityRefusal,
} from "~/modules/provisioning/legal-identity-grounding"
import { AGENT_DELEGATION_UNAVAILABLE } from "~/modules/threads/agent-dispatch-guard"

// Argument validation lives in execute-tool-params.ts; callers keep importing it from here.
export { validateParamsForTool }

// A47b: the manifest's declared defaults, filled on a CLONE as soon as the arguments are
// validated, so the policy judges them, the approval card shows them and the handler runs on
// them: one set of arguments, seen the same way by everyone. See createDefaultFillerCache.
const paramDefaultFiller = createDefaultFillerCache({ allErrors: true, allowUnionTypes: true })

/** The arguments a manifest handler runs on: what the caller sent, plus the schema's defaults. */
export function withManifestDefaults(
  tool: { params?: unknown },
  validatedParams: unknown,
): unknown {
  const schema = tool.params
  if (!schema || typeof schema !== "object" || !("type" in schema)) return validatedParams
  // A Zod schema also carries a `type` ("object"), and ajv refuses to compile one: every
  // kernel tool's dispatch would answer invalid_params ("unknown keyword: toJSONSchema").
  // The same pair of checks validateParamsForTool uses to pick its ajv branch.
  if (typeof (schema as { safeParse?: unknown }).safeParse === "function") return validatedParams
  if (typeof (schema as { type?: unknown }).type !== "string") return validatedParams
  return paramDefaultFiller(schema as SchemaObject, validatedParams)
}

/**
 * A47b. Which paths of the filled arguments the SCHEMA supplied, in the dot-and-index spelling
 * the approval card renders its payload with (`notify`, `options.retries`, `items[0].mode`).
 *
 * The fill only ever ADDS: `coerceTypes` is off and ajv never replaces a value the caller did
 * send, so every difference between the raw arguments and the filled ones is a key the schema
 * put there. That makes this list both the marking the card shows and the exact record of what
 * the agent itself sent: the raw arguments are the payload minus these paths, which is why a
 * second copy of them (and of a sealed mail body with it) is never persisted.
 */
export function defaultedParamPaths(raw: unknown, filled: unknown, prefix = ""): string[] {
  if (raw === filled) return []
  if (Array.isArray(filled)) {
    if (!Array.isArray(raw)) return prefix === "" ? [] : [prefix]
    return filled.flatMap((value, i) => defaultedParamPaths(raw[i], value, `${prefix}[${i}]`))
  }
  if (filled !== null && typeof filled === "object") {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return prefix === "" ? [] : [prefix]
    }
    const rawObj = raw as Record<string, unknown>
    return Object.entries(filled as Record<string, unknown>).flatMap(([key, value]) => {
      const path = prefix === "" ? key : `${prefix}.${key}`
      if (!(key in rawObj)) return [path]
      return defaultedParamPaths(rawObj[key], value, path)
    })
  }
  return []
}

import {
  APP_DISABLED_CODE,
  APP_DISABLED_MESSAGE,
  decidingScopeForToolDef,
  sharedSurfaceDraftReadScope,
} from "@liaison/shared"
import { agentRuns, approvalRequests } from "~/db/schema/kernel"
import {
  captureActingAgentId,
  currentRunContext,
  currentToolCallScopesBefore,
  runHasPerson,
  type SpawnParentFrame,
} from "~/modules/agent/runtime/run-context"
import { hostRequiresApproval } from "~/modules/agent/scopes/host-approval-gates"
import { checkToolScopes, resolveRequiredScopes } from "~/modules/agent/scopes/required-scopes"
import {
  carriesNoTurnContent,
  contentParamsRetryHint,
  isPlatformTaintRefusal,
  markPlatformTaintRefusal,
  markRefusedBeforeRun,
  mcpReadOfOwnServer,
  returnsToOwnMcpServer,
  SCOPE_TAINT_BLOCKED_MESSAGE,
  SCOPE_TAINT_NO_DECIDER_MESSAGE,
  type ScopeTaintAudience,
  SINK_KERNEL_MESSAGES,
  type TaintOriginStore,
  taintDisclosureLine,
  taintOriginOf,
  taintPostDisclosureLine,
  taintSurfaceLabelForTool,
  targetRowIds,
  UNDECLARED_WRITE_TARGET,
  UNKNOWN_TURN_TAINT,
  wasRefusedBeforeRun,
} from "~/modules/agent/scopes/scope-taint"
import {
  checkTaintEscalation,
  isHumanTypedTurn,
  markThreadsForTaintSourceResult,
  outsideTextOnlyFrom,
  untrustedTurnNeedsApproval,
} from "~/modules/agent/scopes/taint"
import {
  conversationReadersTaintGap,
  holdsEveryScope,
  peopleTaintGap,
  readersTaintGap,
  selfReaderTaintGap,
  sinkReaderScopes,
  type TaintAudienceGap,
  taintApprovalAudienceGapDetail,
  threadPeopleIds,
} from "~/modules/agent/scopes/taint-approval-audience"
import { proposingTurnWriteScopes } from "~/modules/agent/scopes/write-required-scopes"
import { OUTSIDE_TEXT_HOLD_NOTE } from "~/modules/agent/tools/outside-text-tools"
import {
  noteNonWebToolCall,
  takeThreadWebRead,
  takeTurnWebRead,
  webFetchUrlRefusal,
  webSearchQueryRefusal,
} from "~/modules/agent/tools/web-read-guardrails"
import {
  resolveToolApprovalAuthority,
  taintDisclosureAuthority,
} from "~/modules/approvals/authority"
import { buildApprovalSummary, proposingTurnScopesUnionSql } from "~/modules/approvals/event-data"
import { humanizeStepSummary } from "~/modules/approvals/ref-provenance"
import { readApprovalRequester } from "~/modules/approvals/requester"
import {
  resolveApprovalResourceOwner,
  resolveRoutineOwnerApprover,
} from "~/modules/approvals/resource-owner"
import {
  narrowPendingApprovalForTaint,
  rowTaintMustHold,
  type TaintNarrowRow,
} from "~/modules/approvals/taint-narrow"
import { appVisibleToOrg } from "~/modules/apps/app-org-scope"
import {
  approvalDedupeKeyRegistry,
  approvalDedupeSameRequesterRegistry,
  approvalEditableFieldsRegistry,
  approvalExpiryRegistry,
} from "~/modules/apps/app-registries"
import { generateApprovalSummary } from "~/modules/apps/approval-summarizers"
import { ingestionCallerApp } from "~/modules/apps/cross-app-ingestions"
import { ensureAppsForOrg, getDefaultApps } from "~/modules/apps/init"
import { APP_STATE_UNAVAILABLE_CODE, isAppActiveForOrgAsync } from "~/modules/apps/org-apps"
import { sealMailApprovalPayload } from "~/modules/mailbox-crypto/approval-payload"
import {
  bypassesDimensionConstraint,
  dimensionGrantCovers,
  eligibleApprovers,
  eligibleApproversWithDimension,
} from "~/modules/permissions/eligible-approvers"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"
import { filterResponse, returnsDimensionDefs } from "~/modules/permissions/response-filter"
import { sendMessage } from "~/modules/threads/message"
import { insertThreadWithParticipants } from "~/modules/threads/thread"
import {
  assertNoScopeTaintedWrite,
  isScopeTaintBlockedWriteError,
} from "~/services/security/visibility"

const APPROVAL_DEFAULT_EXPIRY_HOURS = 168

export function validateToolResult(result: unknown, schema: Record<string, string>): boolean {
  if (result === null || result === undefined) return false

  if (Array.isArray(result)) {
    return result.every((item) => validateSingleResult(item, schema))
  }

  return validateSingleResult(result, schema)
}

function validateSingleResult(item: unknown, schema: Record<string, string>): boolean {
  if (typeof item !== "object" || item === null) return false
  const obj = item as Record<string, unknown>
  for (const [field, expectedType] of Object.entries(schema)) {
    if (!(field in obj)) return false
    if (expectedType !== "any" && typeof obj[field] !== expectedType) return false
  }
  return true
}

// Provenance discriminator. "human-ui" means a real person clicked/typed in the
// product UI and IS the approval; the others are non-human callers that must
// never be mistaken for a direct human click:
//   "in-app-agent" - the in-app agent loop
//   "mcp"          - an MCP client, or a restricted session's REST call
//                    (rest-tool-call.ts): a program, whichever door it used
//   "system"       - a webhook, job, or routine tick with no human in the
//                    loop at all, even when it runs under an actorType:"user"
//                    RLS context (acting AS a user for data visibility, not
//                    because a user clicked anything). Distinct from
//                    "in-app-agent" so a cron-driven mutation is not
//                    misattributed to an agent that never ran.
// Required (not optional) on every call into the core so a call site that
// forgets to set it fails the TypeScript build instead of silently being
// treated as a human click.
export type ToolOrigin = "human-ui" | "in-app-agent" | "mcp" | "system"

interface ExecuteToolParams {
  toolName: string // "appName:toolName" format
  orgId: string
  actor: ActorContext
  params: unknown
  threadId?: string
  /**
   * The calling turn's spawn frame, forwarded by a sandbox hop (`ctx.executeTool`)
   * that has lost the ALS frame. The nested handler's bridge takes it as its own,
   * so a sub-agent it spawns nests below the calling run (and is bounded and
   * tainted by that turn), and a gated call it parks records that run.
   * Undefined: read the live frame as usual.
   */
  spawnParentFrame?: SpawnParentFrame | null
  // Attribution discriminator (Phase 12). Threaded to createRpcBridge's
  // actorType so MCP-originated tool mutations stamp actorType:"mcp".
  // Optional here (the public executeTool() entry point has many callers,
  // most with no opinion on provenance); executeToolCore below requires it,
  // and executeTool()'s own call into the core resolves the fail-closed
  // default explicitly (never "human-ui") so an omitted origin can only ever
  // be gated, never silently treated as a human UI click.
  origin?: ToolOrigin
  /** Step-scoped bundle id from the agent stream loop, when present. */
  stepBundleId?: string | null
  /**
   * Worker-pool scheduling class for any untrusted-app sandbox execution this
   * dispatch triggers. Defaults to "interactive" (a user/agent is waiting).
   * Background dispatchers — sub-agent runs, routine-worker ticks, agent
   * re-invocations, job/outbox workers, and cross-app calls originating from any
   * of those — pass "background" so they cannot starve foreground tool calls
   * (the SandboxWorkerPool reserves capacity for interactive execs).
   */
  priority?: ExecPriority
  /**
   * Cancellation signal from the caller's incoming HTTP request. Threaded
   * through to the sandbox worker pool so an abandoned caller (e.g. after the
   * request timeout middleware responds 504) never later occupies a worker
   * slot for a caller that is already gone. Undefined for callers with no
   * request lifetime to observe (jobs, routines, cross-app calls).
   */
  signal?: AbortSignal
  /**
   * The kernel.agents row acting in this dispatch, for a caller that is not
   * inside an agent run frame and so cannot be read from one: the MCP gateway,
   * whose agent binding lives on the connection rather than in an ALS frame.
   * Forwarded to `actingAgentId`, the single field every audit and approval row
   * already reads (A11/FX18) -- accepted and passed through here, never a
   * second identity mechanism. Absent leaves the live-frame read unchanged.
   */
  agentId?: string
  /**
   * A second thread whose untrusted-content mark this call is ALSO judged on
   * (S59, A34): a desktop gateway turn parks in the person's conversation
   * (`threadId`) while the connection's own thread keeps what the gateway
   * session read. Either thread marked = the call is marked, and a taint
   * source marks both. Absent: only `threadId`, as before.
   */
  alsoJudgeTaintOnThreadId?: string
}

// `requesterCanApprove` is the spec-accurate decision-audience membership
// computed once (hasScope(approveScope, actorScopes)) and also passed to
// createApprovalRequest — surfaced here so callers (MCP selfApproveEligible)
// use the SAME value instead of re-deriving it divergently (spec C7).
interface BlockedEnvelope {
  reason: string
  approvalRequestId?: string
  summary?: ApprovalSummary
  requesterCanApprove: boolean
  /** @ref tokens, present when the gated tool declares referenceableOutputs. */
  outputs?: Record<string, string>
  /** Self-teaching usage instruction, present whenever outputs is. */
  hint?: string
  /** True when this call joined an existing approval bundle. */
  sequenced?: boolean
  /** The tool's `gatedAgentNotes`: what the proposing agent must relay. */
  agentNotes?: Record<string, unknown>
  /** Held because the turn read outside text: how the agent explains it and offers to lift it. */
  outsideText?: string
}

/** The gated tool's notes for the agent; a failure never fails the gate. */
async function gatedAgentNotesFor(
  tool: NonNullable<ReturnType<typeof toolRegistry.get>>,
  params: unknown,
  ctx: { orgId: string; userId: string; scopes: string[] },
): Promise<{ agentNotes?: Record<string, unknown> }> {
  if (!tool.gatedAgentNotes) return {}
  try {
    const notes = await tool.gatedAgentNotes(params, ctx)
    return notes ? { agentNotes: notes } : {}
  } catch (err) {
    log.warn({ err, tool: tool.name }, "gatedAgentNotes failed; the gate goes on without them")
    return {}
  }
}

/** Agent-facing outputs token map + self-teaching hint for a gated block.
 *  Returns {} when the tool declares no referenceableOutputs. */
function buildSequencingOutputs(
  tool: Pick<NonNullable<ReturnType<typeof toolRegistry.get>>, "referenceableOutputs">,
  approvalRequestId: string,
): { outputs?: Record<string, string>; hint?: string } {
  if (!tool.referenceableOutputs || tool.referenceableOutputs.length === 0) return {}
  return {
    outputs: Object.fromEntries(
      tool.referenceableOutputs.map((k) => [k, buildRefToken(approvalRequestId, k)]),
    ),
    hint: sequencingHint(approvalRequestId, tool.referenceableOutputs),
  }
}

interface ExecuteToolResult<TData = unknown> {
  data: TData
  blocked?: BlockedEnvelope
}

export type ExecuteToolEnvelope =
  | { data: unknown }
  | { blocked: BlockedEnvelope }
  | { error: ExecuteToolError }

// `status` + `body` carry a DELIBERATE typed error's precise upstream HTTP classification through
// the envelope (docs/conventions.md "Error reporting & field observability") instead of flattening
// every failure to the code→status map's default 500. Optional: absent for ordinary code-only errors.
type ExecuteToolError = {
  code: string
  message: string
  retryable: boolean
  status?: number
  body?: unknown
}

// BL-180: bounded side-effect-safe auto-retry for tools that opt in via the
// manifest `retryOnTransientDbError` flag. A serialization/deadlock/connection-blip
// aborts the transaction atomically, so re-invoking the handler (a fresh
// withRlsContext = a fresh transaction) is correct, not a duplicate. On exhaustion
// the original error is re-thrown so the existing `transient_db_error` envelope
// (retryable:true) still lets the agent retry as a last resort.
const TRANSIENT_DB_MAX_RETRIES = 2
const TRANSIENT_DB_RETRY_BACKOFF_MS = 25

/**
 * Run `op` and, if it throws a transient DB error AND `enabled`, auto-retry it
 * (fresh transaction each attempt) up to TRANSIENT_DB_MAX_RETRIES times with a
 * small linear backoff. Non-transient errors — and the final transient error
 * after retries are exhausted — propagate to the caller's catch unchanged.
 */
export async function runWithTransientRetry<T>(
  op: () => Promise<T>,
  enabled: boolean,
  toolName: string,
): Promise<T> {
  return retryOnTransientDbError(op, {
    retries: enabled ? TRANSIENT_DB_MAX_RETRIES : 0,
    delayMs: (attempt) => TRANSIENT_DB_RETRY_BACKOFF_MS * attempt,
    onRetry: ({ attempt, code, message }) =>
      log.warn(
        { toolName, attempt, dbCode: code, dbMessage: message },
        "Transient DB error on tool handler — auto-retrying with a fresh transaction (BL-180)",
      ),
  })
}

export interface TaintState {
  taintedSources: string[]
}

export interface ExecuteToolCoreOptions extends ExecuteToolParams {
  // REQUIRED (narrows ExecuteToolParams' optional field): every caller into the
  // core must state its provenance explicitly. isDirectHumanCall only bypasses
  // the approval gate for origin === "human-ui"; a caller that forgets to pass
  // origin now fails to compile instead of silently reading as a human click.
  origin: ToolOrigin
  callChain?: string[]
  /**
   * The sandbox execution this call was dispatched FROM, as a per-execution id
   * (the sandbox bridge's `ctx.executeTool` passes the token of the execution
   * that owns it). The worker pool bounds one execution's fan-out by it.
   */
  parentExecutionToken?: string
  taintState?: TaintState
  internalCall?: {
    callerApp: string
    idempotencyKey?: string
    /** Set by rpc-bridge.ts's `executeTool` bridge when the OUTER call this
     *  nested dispatch is made from was itself human-authorized: a direct
     *  human-UI call BY A USER WHO HOLDS THE OUTER TOOL'S `<app>:approve`
     *  SCOPE (the click is only an approval when the clicker could have
     *  approved it), or a human-approved gated handler re-entry. The bridge
     *  reads it from `bridgeOptions.humanAuthorized`, which executeToolCore
     *  computes — it is NOT re-derived from origin, because origin alone says
     *  nothing about the clicking user's approve authority. Combines with the
     *  declared `cross_app_calls` check to compute
     *  `humanAuthorizedCrossAppCall`. */
    humanAuthorized?: boolean
    /** How the outer call was human-authorized, for the audit row. */
    humanAuthorizedVia?: "human-ui" | "approval"
    /** The OUTER approval whose approved re-entry authorized this nested
     *  dispatch (only set for the "approval" path), for the audit row. */
    outerApprovalRequestId?: string
    /** Set ONLY by the kernel contract dispatch (sandbox `contracts_call`): this hop is the op
     *  `op` of provider contract `contract`, resolved from the caller's binding. The only way
     *  into a `contractOnly` tool. */
    contractCall?: { contract: string; op: string; grant?: string; files?: string[] }
  }
  /**
   * The calling run's "may read, may not write" mark (spec-security.md D4),
   * forwarded by a caller that has crossed a hop losing the ALS frame (the
   * sandbox bridge's `ctx.executeTool`). In-frame callers do not need it: the
   * frame itself is consulted. A write target is refused either way.
   */
  readOnlyRun?: boolean
  /**
   * The calling turn's accumulated scope taint, forwarded by a caller that has
   * crossed a hop losing the ALS frame (the sandbox bridge's `ctx.executeTool`),
   * captured where that frame was still live. Three meaningful values, 2a's
   * `capturedFrameWriteScopes` convention: `[]` is "no turn called this at all"
   * and allows every sink, a scope array is what the turn had read, and `null`
   * is a turn whose taint is not knowable, which is judged as tainted. Absent
   * (an in-frame caller) falls back to the frame itself.
   */
  turnTaintScopes?: string[] | null
  /**
   * The calling turn's taint ORIGIN STORE (A46, A46b), forwarded by a caller that has
   * crossed a hop losing the ALS frame (the sandbox bridge's `ctx.executeTool`). It is
   * the LIVE store, not a snapshot of it: a read made inside the sandbox files its origin
   * into the calling turn exactly as an in-frame read does, and a later write in the same
   * hop is judged against it. Absent (an in-frame caller) falls back to the frame's own
   * accumulator. Kernel-side by construction: the sandbox never supplies it.
   */
  turnTaintOrigins?: TaintOriginStore
  /**
   * FX18. The agent acting in the calling turn, forwarded by a caller that has
   * crossed a hop losing the ALS frame (the sandbox bridge's `ctx.executeTool`),
   * captured where that frame was still live. In-frame callers do not need it:
   * the frame itself is consulted. `null` is a positive "no agent acted".
   */
  actingAgentId?: string | null
}

/**
 * FX13. The proposing turn's scopes to RECORD on an approval row.
 *
 * `proposingTurnWriteScopes()` reads the LIVE run frame -- exactly what a caller
 * that has crossed a frame-losing hop (the sandbox bridge's `ctx.executeTool`
 * and `ctx.requestApproval`) no longer has. There the blind read answers "no
 * turn proposed this" and records `[]`, the positive assertion that nothing
 * scoped was read, so FX4's approved re-entry writes an untagged, world-readable
 * row while the identical ungated call would have carried the turn's scopes.
 *
 * Such a caller FORWARDS what it captured where the frame was still live: FX12's
 * `bridgeTurnTaintScopes`, the SAME value the write is judged against, reused
 * rather than captured again so tag and verdict cannot drift. It wins here.
 *
 * `undefined` is an in-frame caller, which keeps the live-frame read. `null` is
 * a turn whose scopes nothing could determine: it is recorded as SQL NULL, never
 * `[]`, so FX4's `approvalReentryWriteScopes` fails closed on re-entry (the
 * requester's own scope set, or a refusal when there is not one).
 */
function resolveProposingTurnScopes(forwarded: string[] | null | undefined): string[] | null {
  return forwarded !== undefined ? forwarded : proposingTurnWriteScopes()
}

/**
 * FX18. The agent acting in the turn that is recording this approval event, so
 * the durable audit row NAMES it (A11).
 *
 * Same shape and same reasons as `resolveProposingTurnScopes` above, and the
 * same two sources T32 established: an in-frame caller reads the live frame
 * through `captureActingAgentId()`, while a caller that has crossed a
 * frame-losing hop (the sandbox bridge's `ctx.executeTool` and
 * `ctx.requestApproval`) FORWARDS what the bridge captured while the frame was
 * still live. The forwarded value wins, because the in-frame read is blind
 * there and would answer "no agent" for an action an agent plainly took.
 *
 * `undefined` is an in-frame caller. `null` is a positive "no agent acted": a
 * human request, a job, a webhook, or a turn whose agent could not be resolved.
 * FAIL CLOSED ON IDENTITY, NOT ON THE WRITE: an unusable value is coerced to
 * null by `writeAuditLog`, which still writes the row, so the record of the
 * action never dies with the name of the actor, and a human's id is never
 * recorded as an agent.
 */
function resolveActingAgentId(forwarded: string | null | undefined): string | null {
  return forwarded !== undefined ? forwarded : captureActingAgentId()
}

const AGENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The composite foreign key from 0071: `agent_id` must name an agent of the
 *  row's OWN org. Detected by constraint NAME in the failed-query text, exactly
 *  as the bundle-position race is: Drizzle wraps the PG error and the name
 *  appears in one of the two layers' messages. */
const AGENT_FK_CONSTRAINT = "approval_requests_agent_org_fk"

/** True when the approval insert was refused (23503) because its agent id names
 *  no agent of this org. */
function isUnknownAgentFkError(err: unknown): boolean {
  const message = `${String((err as { message?: unknown })?.message ?? "")}|${String(
    (err as { cause?: { message?: unknown } })?.cause?.message ?? "",
  )}`
  return message.includes(AGENT_FK_CONSTRAINT)
}

/**
 * What may be PERSISTED in `kernel.approval_requests.agent_id`: a uuid-typed
 * column whose COMPOSITE foreign key (0071) requires an agent of this ORG.
 *
 * FAIL CLOSED ON IDENTITY, NEVER ON THE APPROVAL. Two kinds of unusable id
 * reach this column, and BOTH record a positive null while the approval still
 * stages:
 *
 *  - a value that is not a uuid is coerced here, loudly (the 22P02 case);
 *  - a value that IS a uuid but names no agent of this org passes this shape
 *    check, because only the foreign key can know. Every insert site therefore
 *    retries ONCE with a null agent when 0071 refuses it (see
 *    `isUnknownAgentFkError`). The retry runs only after a failure, so the
 *    happy path costs nothing: no SAVEPOINT, no extra round trip, no probe
 *    SELECT. It re-allocates a handle from the sequence, which the
 *    bundle-position retry beside it already does.
 *
 * Letting that second case escape used to KILL THE APPROVAL: the staging
 * transaction rolled back, the gated call threw postgres's failed-query text
 * naming no cause, and the human never saw a card, so the action was neither
 * done nor pending. It is reachable without anyone inventing an id: erasing a
 * user hard-deletes their personal agent (`erase-user.ts`), so an agent id can
 * stop naming a row while that agent's turn is mid-staging. Losing the
 * proposer's NAME is recoverable; losing the human's DECISION is not, and the
 * malformed-id branch already made that same trade.
 *
 * A human's id is never written here: the only input is the resolved acting
 * AGENT, and `null` is a positive "no agent proposed this". Both branches are
 * pinned by `execute-tool-unknown-agent-identity.test.ts`.
 */
function persistableAgentId(actingAgentId: string | null): string | null {
  if (actingAgentId === null) return null
  if (AGENT_UUID_RE.test(actingAgentId)) return actingAgentId
  log.warn(
    { agentId: actingAgentId },
    "Approval request carried an unusable agent id - recording no agent",
  )
  return null
}

interface CreateApprovalRequestOpts {
  orgId: string
  threadId: string
  toolName: string
  toolParams: unknown
  /** A47b: the payload paths the manifest's schema supplied, marked on the card. The agent's
   *  own arguments are this payload minus these paths, which is how the row keeps them. */
  defaultedParams?: string[]
  requestedBy: string
  reason: string
  summary: ApprovalSummary
  appName: string
  toolShortName: string
  requesterCanApprove: boolean
  origin?: ToolOrigin
  /** Custom decision scope for this approval (dimension-constrained approvals).
   *  Defaults to `${appName}:approve` when unset. Persisted on the row. */
  approveScope?: string
  /** Optional dimension constraint the decider/audience must cover. Persisted on
   *  the row; used to filter the notified approver audience. */
  dimensionConstraint?: { key: string; values: string[] } | null
  /** When set, the row joins the given bundle. The position is allocated atomically
   *  inside the transaction with a 23505 retry under the partial UNIQUE index. */
  bundleId?: string | null
  /** Edge to a source approval. Independent of `bundleId`. */
  dependsOnId?: string | null
  /**
   * FX13: the proposing turn's scopes, forwarded by a caller that crossed a
   * frame-losing hop (the sandbox bridge). Absent means an in-frame caller,
   * which keeps the live-frame read; see `resolveProposingTurnScopes`.
   */
  proposingTurnScopes?: string[] | null
  /**
   * Scopes every NOTIFIED approver must hold: set for a gated write staged from a
   * scope-tainted turn (scope-taint.ts, consequence 2), whose payload carries what
   * that turn read. Approvers lacking any of them are not routed the request, so
   * they neither see it in their feed nor may decide it. The requester stays: the
   * dispatch already checked they hold them.
   */
  audienceMustHold?: string[]
  /** Readers of the write's target lack those scopes (rule 8e): the card carries the disclosure
   *  line, which an in-place edit of the row (rule 8g) rebuilds. */
  taintDisclosedToReaders?: boolean
  /** An agent post parked by rule 11: the people of its thread when it parked. Approving it
   *  discloses the post to them, never to anyone who joined since. */
  taintDisclosureAudience?: string[]
  /**
   * FX18: the acting agent, forwarded by a caller that crossed the same
   * frame-losing hop. Absent means an in-frame caller; see
   * `resolveActingAgentId`.
   */
  actingAgentId?: string | null
  /**
   * Pre-generated approval id. Lets a caller that must reference the approval
   * before it exists (e.g. handler-conditional gating, which auto-creates the
   * surface thread with `createdFrom` pointing back at the approval) pin the id.
   * Defaults to a fresh UUID.
   */
  id?: string
  /**
   * Approval-TIGHTENING metadata (BL-268). When an org approval-policy escalated
   * this gate, persist the N-eyes floor + triggering policy so decide.ts can
   * enforce the distinct-approver requirement and the card can explain it.
   */
  tighten?: {
    minApprovers: number
    tightenedByPolicy?: string
    tightenReason?: string
    /** A person's own N-eyes call by someone who could decide it: their click
     *  is recorded as the first distinct sign-off (`metadata.approvedBy`). */
    requesterSignedOff?: boolean
  }
  /**
   * The agent run that proposed this call, for a caller whose frame is gone (a
   * sandbox hop). Undefined reads the live frame; null says no run. Persisted
   * (as `metadata.originRun`) only for a sub-run, so the approved re-entry nests
   * any sub-agent it spawns below that run instead of at depth 0.
   */
  originRun?: OriginRun | null
}

/** The proposing agent run of an approval: id, root and nesting depth. */
export interface OriginRun {
  runId: string
  rootRunId: string
  nestingDepth: number
}

/** A persisted `metadata.originRun`, validated (it comes back from jsonb). */
export function parseOriginRun(v: unknown): OriginRun | undefined {
  if (!v || typeof v !== "object") return undefined
  const o = v as Record<string, unknown>
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (typeof o.runId !== "string" || !uuid.test(o.runId)) return undefined
  if (typeof o.rootRunId !== "string" || !uuid.test(o.rootRunId)) return undefined
  if (typeof o.nestingDepth !== "number" || !Number.isInteger(o.nestingDepth) || o.nestingDepth < 1)
    return undefined
  return { runId: o.runId, rootRunId: o.rootRunId, nestingDepth: o.nestingDepth }
}

/**
 * Decide the EFFECTIVE gating for a tool call and whether it may skip the human
 * approval. Two policy stores are composed under a strict TIGHTEN-ONLY rule:
 *
 *  1. The org's approval-TIGHTENING policy (`evaluateApprovalPolicy`) ESCALATES:
 *     a non-gated action can become gated (`require_approval`), a 1-approver
 *     action can become N-eyes (`min_approvers`). The effective gating is the
 *     MAX of (built-in `tool.gated` / built-in minApprovers, policy demand) via
 *     `composeGate` — a policy can NEVER un-gate or lower the floor.
 *  2. The org's auto-approve (LOOSENING) policy (`evaluateAutoApprove`) may then
 *     let a gated call skip — but ONLY when the tightening policy did NOT raise
 *     the approver floor to ≥2 (a second distinct human can't be auto-approved
 *     away). The tighten store always wins over the loosen store.
 *
 * `skip` is true ONLY when:
 *  - the effective gate is open (not gated after tightening); OR
 *  - the direct-human-approver bypass holds (a UI click IS the approval) AND the
 *    tightening policy did NOT demand N-eyes (≥2 distinct approvers); OR
 *  - an auto-approve policy fires, params carry NO `@ref` tokens, AND the
 *    tightening policy did NOT demand N-eyes.
 *
 * CRITICAL ordering: `findRefTokens` runs BEFORE the auto-approve policy is
 * consulted, so a `@ref`-bearing sequenced bundle step can never be
 * auto-approved even when a loosen policy would match. The taint gate is
 * intentionally OUTSIDE this predicate.
 */
/** Load an actor's effective dimension-grant map (dimensionGrants) under the
 *  privileged pool — used to test whether a requester's own grants cover a gated
 *  tool's dimension constraint for self-approval. */
async function loadActorDimensionGrants(
  orgId: string,
  userId: string,
): Promise<Record<string, string[]>> {
  return withPrivilegedDb(orgId, "approval-load-requester-dim-grants", async (tx) => {
    const perms = await loadEffectivePermissions(tx, userId, orgId)
    return perms.dimensionGrants
  })
}

/** Why a person's own direct call was refused at the gate (see `computeSkipGate`). */
export type PersonRefusal = "missing_scope" | "sequenced" | "policy_unavailable"

/** The 403 a refused person's call answers with: what they lack, in words they can act on.
 *  `missingScopes` are the tool's OWN required scopes the person does not hold. */
export function personRefusalError(
  refusal: PersonRefusal,
  toolName: string,
  missingScopes: readonly string[],
): {
  code: string
  message: string
  retryable: boolean
  status: number
  details?: { missingScope: string; requestable: boolean }
} {
  if (refusal === "policy_unavailable") {
    // Fail closed: whether the org demands a second approver is unknown, so
    // the call neither runs nor parks. Nothing happened; trying again is safe.
    return {
      code: "approval_policy_unavailable",
      message: `${toolName} did not run: your organization's approval policy could not be read just now. Nothing was done; try again in a moment.`,
      retryable: true,
      status: 503,
    }
  }
  if (refusal === "missing_scope") {
    const named = missingScopes.length > 0 ? missingScopes.join(", ") : "a permission"
    return {
      code: "forbidden",
      message: `You cannot run ${toolName}: it needs the ${named} permission, which you do not hold.`,
      retryable: false,
      status: 403,
      ...(missingScopes[0]
        ? { details: { missingScope: missingScopes[0], requestable: true } }
        : {}),
    }
  }
  return {
    code: "forbidden",
    message: personSequencedMessage(toolName),
    retryable: false,
    status: 403,
  }
}

export async function computeSkipGate(a: {
  gated: boolean
  isDirectHumanCall: boolean
  /** A person's own call: whether they hold every one of the tool's OWN
   *  `requiredScopes` (checkToolScopes). This, not the approve scope, decides
   *  whether their call runs. Read only when `isDirectHumanCall`. */
  personHoldsToolScopes?: boolean
  requesterCanApprove: boolean
  orgId: string
  toolName: string
  appName: string
  // Only the actor's scopes are read (by the policy `requiresScope` check), so
  // the structural subset `evaluateAutoApprove` needs — satisfied by both the
  // real ActorContext and an agent-shaped actor.
  actor: { scopes?: string[]; actorType?: string; userId?: string; orgId?: string }
  validatedParams: unknown
  evaluate: typeof evaluateAutoApprove
  evaluatePolicy?: typeof evaluateApprovalPolicy
  /** True when this call is a cross-app (`internalCall`) dispatch whose target
   *  the CALLING app's manifest declares in `cross_app_calls` (the same
   *  `approvedCrossAppCall` computed for the app-capability authorization gate
   *  above — threaded here so a machine-origin dispatch into a declared target
   *  can execute deterministically instead of failing outright for lack of a
   *  thread to attach an approval request to). */
  machineAuthorizedCrossAppCall?: boolean
  /** The dispatch's provenance. Only "system" (a webhook, job or routine tick —
   *  never a human-attributed hop; see rpc-bridge.ts's human-ui downgrade)
   *  combines with `machineAuthorizedCrossAppCall` to skip. */
  origin?: ToolOrigin
  /** True when this call is BOTH a declared `cross_app_calls` dispatch
   *  (`machineAuthorizedCrossAppCall`) AND made from a handler that is itself
   *  running because a human authorized it (a direct human-UI outer call, or a
   *  human-approved gated handler re-entry). Computed in `executeToolCore` from
   *  `opts.internalCall.humanAuthorized`, which rpc-bridge.ts's `executeTool`
   *  bridge sets from its own `bridgeOptions.humanAuthorized` (the outer
   *  human-UI click BY AN APPROVE-SCOPE HOLDER, computed in executeToolCore)
   *  or `approvalContext != null`. */
  humanAuthorizedCrossAppCall?: boolean
  /** How the outer call was human-authorized — audit metadata for the arm. */
  humanAuthorizedVia?: "human-ui" | "approval"
  /** The outer approval that authorized this hop — audit metadata for the arm. */
  outerApprovalRequestId?: string
  /** The acting (human) user id behind the hop — audit metadata for the arm. */
  outerActorId?: string
  /** The declared caller app, surfaced on the audit row when the new arm fires. */
  callerApp?: string
  /** Tool flag `noAutoApprove`: neither an auto-approve policy nor a capability arm may skip
   *  the gate; only the human-UI approver bypass (the click IS the approval) remains. */
  noAutoApprove?: boolean
  /** Whether the calling turn read untrusted outside text; handed to the auto-approve policy. */
  untrustedTurn?: () => Promise<boolean>
}): Promise<{
  skip: boolean
  /** Effective gating after tighten-only composition — drives the gate branch. */
  effectiveGated: boolean
  /** The call carries `@ref` tokens, so it must DEFER into the sequenced bundle
   *  even when it is not independently gated (deferral is orthogonal to gating). */
  mustSequence: boolean
  /** Distinct-approver floor the gate must enforce (≥2 = N-eyes). */
  minApprovers: number
  /** Set when the tightening policy STRICTLY escalated beyond the built-in. */
  tightenedByPolicy?: string
  tightenReason?: string
  autoApprovedByPolicy?: string
  /** Set when the new machine-authorized cross-app arm fired — the declared
   *  caller app, for the audit row (distinct from `autoApprovedByPolicy`, which
   *  is a human-facing org auto-approve policy, not a manifest capability). */
  autoApprovedByCapability?: string
  /** Set ONLY when the HUMAN-authorized cross-app arm fired (never the machine
   *  arm). Both arms share `reason: "auto_approved_by_capability"`, so without
   *  this marker the audit row cannot tell "a webhook's declared hop" from
   *  "a human's click/approval carried into a declared hop". Merged into the
   *  synthetic approval's metadata. */
  capabilityHumanAuthorization?: {
    humanAuthorized: true
    authorizedVia: "human-ui" | "approval"
    outerActorId?: string
    approvalRequestId?: string
  }
  /** Set when a person's own direct call (`isDirectHumanCall`) is refused (403,
   *  never parked, never auto-approved):
   *   - "missing_scope": the person does not hold the tool's own required scopes.
   *   - "sequenced": the call carries `@ref` tokens, which only an agent's
   *     staged bundle can resolve. */
  personRefusal?: PersonRefusal
}> {
  // 1. Tighten-only composition — the policy can only ADD/RAISE a requirement.
  const evaluatePolicy = a.evaluatePolicy ?? evaluateApprovalPolicy
  let policyDecision: ApprovalPolicyDecision = { requireApproval: false, minApprovers: 1 }
  let policyUnreadable = false
  // Fail-OPEN is SAFE for tightening on an agent's call: a load/eval error
  // leaves built-in gating untouched (never loosens) — the call still parks.
  // A person's own call to a gated tool is different: it RUNS when no policy
  // tightens it, so an unreadable policy fails CLOSED for it (below).
  try {
    policyDecision = await evaluatePolicy({
      orgId: a.orgId,
      toolName: a.toolName,
      appName: a.appName,
      params: a.validatedParams,
    })
  } catch (err) {
    policyUnreadable = true
    log.error(
      { err, toolName: a.toolName, orgId: a.orgId },
      "approval-policy evaluation failed — leaving built-in gating untouched (tighten-only fail-open)",
    )
  }
  const composed = composeGate({ gated: a.gated, minApprovers: 1 }, policyDecision)
  // An @ref-bearing call must DEFER into the sequenced bundle regardless of
  // whether the tool is independently gated: its @ref input only resolves at
  // cascade time, so executing it inline (skip:true) would run it against an
  // unresolved `@ref:…` placeholder (the token-runaway "Tool execution failed"
  // class). Deferral is ORTHOGONAL to gating — a NON-gated tool can be a step
  // in a gated sequence: it joins the bundle as a `deferred` dependent and
  // auto-runs in bundle-position order under the bundle's SINGLE human approval
  // (cascadeDeferredDependents), adding no approval of its own. This check runs
  // BEFORE the non-gated skip AND the human-approver bypass so an @ref step is
  // never executed inline. (Also keeps the pre-existing invariant that an @ref
  // step can never be auto-approved by a loosen policy.)
  const mustSequence = findRefTokens(a.validatedParams).length > 0
  const base = {
    effectiveGated: composed.gated,
    mustSequence,
    minApprovers: composed.minApprovers,
    tightenedByPolicy: composed.policyId,
    tightenReason: composed.reason,
  }

  // N-eyes (≥2 distinct approvers) can NEVER be skipped by the self-approve
  // bypass or by an auto-approve policy — a second distinct human is required.
  const requiresSecondApprover = composed.minApprovers >= 2
  // Approvals are for agents, not persons. A person's own direct call (REST/UI,
  // actor type user) is decided by the tool's OWN permission: it runs when they
  // hold the tool's required scopes, exactly as an ungated tool does, and is
  // refused (403) otherwise. The approve scope plays no part. The one exception
  // is an org two-approver (N-eyes) policy: the call parks, the person's click
  // counting as one sign-off when they could decide it, and a further DISTINCT
  // person must approve. An auto-approve policy never answers a person's call.
  if (a.isDirectHumanCall) {
    if (a.personHoldsToolScopes !== true) {
      return { skip: false, ...base, personRefusal: "missing_scope" }
    }
    if (mustSequence) return { skip: false, ...base, personRefusal: "sequenced" }
    // A gated tool would otherwise run on the person's scope without knowing
    // whether the org demands a second approver: fail closed (retryable).
    if (policyUnreadable && composed.gated) {
      return { skip: false, ...base, personRefusal: "policy_unavailable" }
    }
    if (!composed.gated) return { skip: true, ...base }
    if (requiresSecondApprover) return { skip: false, ...base }
    return { skip: true, ...base }
  }
  if (mustSequence) return { skip: false, ...base }
  if (!composed.gated) return { skip: true, ...base }
  if (requiresSecondApprover) return { skip: false, ...base } // N-eyes: never auto-approve
  // An outbound legal action (e.g. transmitting an e-invoice): no machine path waves it through.
  if (a.noAutoApprove) return { skip: false, ...base }
  // Machine-authorized cross-app dispatch: a "system" origin call (webhook,
  // job, routine tick — never a human-attributed hop) into a tool the CALLING
  // app's manifest declares as a cross_app_calls target executes deterministically.
  // Placed after the N-eyes check so a two-eyes policy still wins, and gated on
  // origin === "system" specifically: "in-app-agent" and "mcp" are real,
  // attributable re-entrant provenance and must keep gating exactly like any
  // other non-human call — this arm must not weaken that boundary.
  if (!requiresSecondApprover && a.machineAuthorizedCrossAppCall && a.origin === "system") {
    return { skip: true, ...base, autoApprovedByCapability: a.callerApp }
  }
  // Human-authorized cross-app dispatch: a nested `ctx.executeTool` call into a
  // DECLARED `cross_app_calls` target, made from a handler that is itself
  // running because a human authorized it — either a direct human-UI call
  // (the outer click) or a human-approved gated handler re-entry
  // (approvalContext present). The human already reviewed the OUTER action;
  // the inner call is a deterministic consequence of it, not a separate
  // agent-initiated action, so it must not park its own approval (that class
  // of bug wedges the outer approval to `pending` on "threadId required").
  // `humanAuthorizedCrossAppCall` is only ever true when
  // `machineAuthorizedCrossAppCall` (the manifest-declared target check) is
  // also true — an undeclared target stays gated regardless of provenance.
  if (!requiresSecondApprover && a.humanAuthorizedCrossAppCall) {
    return {
      skip: true,
      ...base,
      autoApprovedByCapability: a.callerApp,
      capabilityHumanAuthorization: {
        humanAuthorized: true,
        authorizedVia: a.humanAuthorizedVia ?? "human-ui",
        ...(a.outerActorId ? { outerActorId: a.outerActorId } : {}),
        ...(a.outerApprovalRequestId ? { approvalRequestId: a.outerApprovalRequestId } : {}),
      },
    }
  }
  const r = await a.evaluate({
    orgId: a.orgId,
    toolName: a.toolName,
    params: a.validatedParams,
    actor: a.actor,
    appName: a.appName,
    ...(a.untrustedTurn ? { untrustedTurn: a.untrustedTurn } : {}),
  })
  return r.decision === "auto_approve"
    ? { skip: true, ...base, autoApprovedByPolicy: r.policyId }
    : { skip: false, ...base }
}

/**
 * Record a synthetic `approval_request` pre-set to `approved` for an
 * auto-approved (policy-fired) gated tool call. Reuses the existing approval
 * substrate (same `tool_name`/`tool_params`/`appName`/`requestedBy` envelope,
 * the same handle sequence) so the autonomous approval is auditable exactly like
 * a human one. Decided by the requester, tagged `autoApprovedByPolicy:<id>`.
 */
async function writeSyntheticPolicyApproval(opts: {
  /** A pre-generated id for the row (a handler-requested approval names it before it exists). */
  id?: string
  orgId: string
  threadId: string
  toolName: string
  toolParams: unknown
  requestedBy: string
  appName: string
  policyId: string
  /** FX13: forwarded by a caller that crossed a frame-losing hop. */
  proposingTurnScopes?: string[] | null
  /** A11: the acting agent, forwarded the same way and for the same reason. */
  actingAgentId?: string | null
}): Promise<void> {
  const payloadJson = JSON.parse(JSON.stringify(opts.toolParams ?? {}))
  const now = new Date()
  // Recorded for completeness even though this row is born `approved` and is
  // never re-entered: it is the same envelope as a human-decided approval, so
  // it answers the same question about the turn that made the call.
  const proposingTurnScopes = resolveProposingTurnScopes(opts.proposingTurnScopes)
  // A11: recorded for the same reason as the scopes above -- this row is the
  // audit envelope of an AUTONOMOUS approval, so it must name the agent whose
  // turn made the call it approved.
  const actingAgentId = resolveActingAgentId(opts.actingAgentId)
  // Retried once with no agent if 0071 refuses the id: the auto-approved record
  // must survive an agent that no longer exists (see `persistableAgentId`).
  let rowAgentId = persistableAgentId(actingAgentId)
  for (let attempt = 0; ; attempt++) {
    try {
      await withPrivilegedDb(opts.orgId, "synthetic-policy-approval", async (tx) => {
        const handle = await nextApprovalHandle(tx, opts.orgId)
        await tx.insert(approvalRequests).values({
          ...(opts.id ? { id: opts.id } : {}),
          orgId: opts.orgId,
          handle,
          threadId: opts.threadId,
          originatingThreadId: opts.threadId,
          toolName: opts.toolName,
          toolParams: payloadJson,
          currentPayload: payloadJson,
          expiresAt: now,
          requestedBy: opts.requestedBy,
          status: "approved",
          reason: "auto_approved_by_policy",
          decidedBy: opts.requestedBy,
          decidedAt: now,
          proposingTurnScopes,
          agentId: rowAgentId,
          metadata: { autoApprovedByPolicy: opts.policyId, appName: opts.appName },
        })
      })
      break
    } catch (err) {
      if (attempt === 0 && rowAgentId !== null && isUnknownAgentFkError(err)) {
        log.warn(
          { agentId: rowAgentId, orgId: opts.orgId, toolName: opts.toolName },
          "Auto-approved policy record named an agent that does not exist - recording no agent",
        )
        rowAgentId = null
        continue
      }
      if (attempt < HANDLE_COLLISION_ATTEMPTS && isApprovalHandleCollision(err)) continue
      throw err
    }
  }
}

/**
 * Record a synthetic `approval_request` pre-set to `approved` for a
 * MACHINE-authorized cross-app dispatch (the new `computeSkipGate` arm: a
 * "system" origin call into a tool the calling app's manifest declares as a
 * `cross_app_calls` target). Mirrors `writeSyntheticPolicyApproval` but tags
 * the row `autoApprovedByCapability` instead of `autoApprovedByPolicy` so the
 * two auto-execution paths — an org's human-facing auto-approve policy vs. an
 * operator-approved app-to-app capability grant — stay distinguishable in the
 * audit trail. Same threadId/requestedBy FK requirements as the policy path,
 * so it can only run when a thread and a real user are available; the caller
 * falls back to a structured log for the threadless machine-origin case (a
 * webhook has no thread and no human requester to attach the row to).
 */
/**
 * A handle another transaction took between this one's counter bump and its
 * insert (approval_requests_org_handle_idx). The counter skips numbers already
 * committed, so the whole transaction is retried once more with the next one.
 */
export function isApprovalHandleCollision(err: unknown): boolean {
  const message = `${String((err as { message?: unknown })?.message ?? "")}|${String(
    (err as { cause?: { message?: unknown } })?.cause?.message ?? "",
  )}`
  return message.includes("approval_requests_org_handle_idx")
}

const HANDLE_COLLISION_ATTEMPTS = 3

async function writeSyntheticCapabilityApproval(opts: {
  orgId: string
  threadId: string
  toolName: string
  toolParams: unknown
  requestedBy: string
  appName: string
  callerApp: string
  /** Present only for the HUMAN-authorized arm — see
   *  `computeSkipGate`'s `capabilityHumanAuthorization`. */
  humanAuthorization?: {
    humanAuthorized: true
    authorizedVia: "human-ui" | "approval"
    outerActorId?: string
    approvalRequestId?: string
  }
}): Promise<void> {
  const payloadJson = JSON.parse(JSON.stringify(opts.toolParams ?? {}))
  const now = new Date()
  for (let attempt = 0; ; attempt++) {
    try {
      await insertSyntheticCapabilityApproval(opts, payloadJson, now)
      return
    } catch (err) {
      if (attempt < HANDLE_COLLISION_ATTEMPTS - 1 && isApprovalHandleCollision(err)) continue
      throw err
    }
  }
}

async function insertSyntheticCapabilityApproval(
  opts: Parameters<typeof writeSyntheticCapabilityApproval>[0],
  payloadJson: unknown,
  now: Date,
): Promise<void> {
  await withPrivilegedDb(opts.orgId, "synthetic-capability-approval", async (tx) => {
    const handle = await nextApprovalHandle(tx, opts.orgId)
    await tx.insert(approvalRequests).values({
      orgId: opts.orgId,
      handle,
      threadId: opts.threadId,
      originatingThreadId: opts.threadId,
      toolName: opts.toolName,
      toolParams: payloadJson,
      currentPayload: payloadJson,
      expiresAt: now,
      requestedBy: opts.requestedBy,
      status: "approved",
      reason: "auto_approved_by_capability",
      decidedBy: opts.requestedBy,
      decidedAt: now,
      metadata: {
        autoApprovedByCapability: opts.callerApp,
        appName: opts.appName,
        target: opts.toolName,
        ...(opts.humanAuthorization ?? {}),
      },
    })
  })
}

/**
 * Opt-in gated-approval IDEMPOTENCY. When a gated tool declares
 * `approvalDedupeKeyParam` (the manifest names a single param whose value
 * uniquely identifies the action — e.g. boxtal:create_shipment's `draft_id`),
 * staging a SECOND approval for the same (org, tool, key-value) while a prior one
 * is still PENDING must not create a duplicate: the human would otherwise see two
 * pending approvals for one order (and, if both are approved, ship it twice). This
 * looks up an existing pending (un-decided) approval with the same tool + key value
 * and returns its id so the caller can re-surface that SAME blocked envelope.
 *
 * Returns the existing pending approval's id, or null when there is none (stage a
 * fresh one). Read-only; runs under the privileged pool like the other approval
 * helpers. The key value is matched against the persisted `tool_params` jsonb so it
 * survives editable-field edits to OTHER params.
 */
async function findExistingPendingApprovalByDedupeKey(args: {
  orgId: string
  toolName: string
  keyParam: string
  keyValue: string
  /** When set, only a pending approval staged by this exact identity matches:
   *  same requester, same acting agent (null = none), same originating routine
   *  (null = none). Anyone else's pending approval is never restaged. */
  sameRequester?: { requestedBy: string; agentId: string | null; routineId: string | null }
}): Promise<string | null> {
  const who = args.sameRequester
  return withPrivilegedDb(args.orgId, "gated-approval-dedupe-lookup", async (tx) => {
    const rows = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.orgId, args.orgId),
          eq(approvalRequests.toolName, args.toolName),
          eq(approvalRequests.status, "pending"),
          // tool_params->>'<keyParam>' = '<keyValue>' — match the staged action's id.
          drizzleSql`${approvalRequests.toolParams}->>${args.keyParam} = ${args.keyValue}`,
          ...(who
            ? [
                eq(approvalRequests.requestedBy, who.requestedBy),
                drizzleSql`${approvalRequests.agentId} IS NOT DISTINCT FROM ${who.agentId}::uuid`,
                drizzleSql`${approvalRequests.metadata}->>'originRoutineId' IS NOT DISTINCT FROM ${who.routineId}::text`,
              ]
            : []),
        ),
      )
      .orderBy(approvalRequests.createdAt)
      .limit(1)
    return rows[0]?.id ?? null
  })
}

/**
 * Who alone decides an approval for a personal resource (a personal mailbox, a
 * personal MCP connection's tool, a routine set to `approver: "owner"`), or
 * null when it fans out to the org's deciders. The one routing answer, read by
 * `createApprovalRequest` and by the N-eyes audience check before it.
 */
async function resolveApprovalOwnerRouting(a: {
  orgId: string
  appName: string
  toolShortName: string
  toolParams: unknown
  requestedBy: string
  approveScope: string
  dimensionConstraint: { key: string; values: string[] } | null
  mustHold: string[]
  /** The acting agent (a write to its own memory is its owner's): absent reads the live frame. */
  actingAgentId?: string | null
}): Promise<string | null> {
  const originRoutineId = currentRunContext()?.routineId
  const personalToolOwnerId =
    toolRegistry.get([a.orgId, a.appName, a.toolShortName])?.ownerUserId ?? null
  return (
    (await resolveApprovalResourceOwner(
      a.orgId,
      a.appName,
      a.toolShortName,
      a.toolParams,
      a.requestedBy,
      resolveActingAgentId(a.actingAgentId),
    )) ??
    personalToolOwnerId ??
    (originRoutineId
      ? await resolveRoutineOwnerApprover({
          orgId: a.orgId,
          routineId: originRoutineId,
          approveScope: a.approveScope,
          dimensionConstraint: a.dimensionConstraint,
          mustHold: a.mustHold,
        })
      : null)
  )
}

/** An N-eyes policy demands more distinct approvers than this request's
 *  audience can ever provide: refused at stage time (409), never parked. */
export class ApproversUnavailableError extends Error {
  readonly code = "approvers_unavailable"
  readonly status = 409
  readonly retryable = false
  constructor(toolName: string, required: number, available: number, ownerRouted: boolean) {
    super(
      ownerRouted
        ? `${toolName} cannot be approved: your organization requires ${required} distinct approvers for it, but it acts on a personal resource only its owner may approve. Ask an admin to change the approval policy for this tool.`
        : `${toolName} cannot be approved: your organization requires ${required} distinct approvers for it, but only ${available} person${available === 1 ? "" : "s"} may approve it. Ask an admin to grant the approve permission to more people, or to change the approval policy.`,
    )
    this.name = "ApproversUnavailableError"
  }
}

/**
 * Refuse an N-eyes request whose audience can never reach the floor: an
 * owner-routed approval has exactly one decider (its owner), and a fan-out
 * approval has only the people holding the deciding scope (and the dimension
 * and taint constraints). Parking it would wait for a second approver who
 * cannot exist until it expires.
 */
export async function assertApproversAvailable(a: {
  orgId: string
  toolName: string
  minApprovers: number
  resourceOwnerId: string | null
  approveScope: string
  dimensionConstraint: { key: string; values: string[] } | null
  mustHold: string[]
}): Promise<void> {
  if (a.minApprovers < 2) return
  if (a.resourceOwnerId) {
    throw new ApproversUnavailableError(a.toolName, a.minApprovers, 1, true)
  }
  const toolApp = a.toolName.split(":")[0]
  const available = await withPrivilegedDb(a.orgId, "approval-neyes-audience", async (tx) => {
    let approvers = a.dimensionConstraint
      ? await eligibleApproversWithDimension(
          tx,
          a.orgId,
          a.approveScope,
          a.dimensionConstraint,
          toolApp,
        )
      : await eligibleApprovers(tx, a.orgId, a.approveScope, toolApp)
    for (const scope of a.mustHold) {
      const holders = new Set(await eligibleApprovers(tx, a.orgId, scope))
      approvers = approvers.filter((u) => holders.has(u))
    }
    return new Set(approvers).size
  })
  if (available < a.minApprovers) {
    throw new ApproversUnavailableError(a.toolName, a.minApprovers, available, false)
  }
}

/**
 * Whether anyone may decide a TAINTED approval (scope-taint.ts, rule 8): the routed owner when
 * the request is owner-routed (it is then their only decider), else one holder of the deciding
 * scope (and the dimension constraint) who also holds every scope the turn read. False means the
 * approval would wait for a decider who cannot exist, so the dispatch refuses it instead: the one
 * case a tainted gated write is still refused for its audience.
 */
async function taintedApprovalHasDecider(a: {
  orgId: string
  /** The app of the tool being approved: its restriction decides who may approve. */
  toolApp: string
  resourceOwnerId: string | null
  approveScope: string
  dimensionConstraint: { key: string; values: string[] } | null
  mustHold: string[]
}): Promise<boolean> {
  return withPrivilegedDb(a.orgId, "approval-taint-decider", async (tx) => {
    if (a.resourceOwnerId) {
      const { scopes } = await loadEffectivePermissions(tx, a.resourceOwnerId, a.orgId)
      return a.mustHold.every((scope) => hasScope(scope, scopes))
    }
    let approvers = a.dimensionConstraint
      ? await eligibleApproversWithDimension(
          tx,
          a.orgId,
          a.approveScope,
          a.dimensionConstraint,
          a.toolApp,
        )
      : await eligibleApprovers(tx, a.orgId, a.approveScope, a.toolApp)
    for (const scope of a.mustHold) {
      const holders = new Set(await eligibleApprovers(tx, a.orgId, scope))
      approvers = approvers.filter((u) => holders.has(u))
    }
    return approvers.length > 0
  })
}

async function createApprovalRequest(opts: CreateApprovalRequestOpts): Promise<string> {
  const {
    orgId,
    threadId,
    toolName,
    toolParams,
    requestedBy,
    reason,
    summary,
    appName,
    toolShortName,
    origin,
  } = opts
  // Dimension-constrained approvals: a custom decision scope + optional dimension
  // constraint override the derived default. The derivation is the shared
  // authority answer, so write-time and read-time can never disagree.
  const approveScope = decidingScopeForToolDef({ approveScope: opts.approveScope }, appName)
  const dimensionConstraint = opts.dimensionConstraint ?? null
  // Approval-tightening metadata (BL-268): persist the N-eyes floor + triggering
  // policy so decide.ts can enforce the distinct-approver requirement. Only set
  // when a policy escalated (minApprovers ≥ 2 OR a tightening policy fired).
  const tightenMeta: Record<string, unknown> =
    opts.tighten && (opts.tighten.minApprovers >= 2 || opts.tighten.tightenedByPolicy)
      ? {
          minApprovers: opts.tighten.minApprovers,
          ...(opts.tighten.tightenedByPolicy
            ? { tightenedByPolicy: opts.tighten.tightenedByPolicy }
            : {}),
          ...(opts.tighten.tightenReason ? { tightenReason: opts.tighten.tightenReason } : {}),
          ...(opts.tighten.requesterSignedOff && opts.tighten.minApprovers >= 2
            ? { approvedBy: [requestedBy] }
            : {}),
        }
      : {}
  // ROUTINE ORIGIN. A routine executes as its OWNER (agentInvoker runs
  // withRlsContext as ownerUserId), so `requested_by` on this row is the person
  // who happens to have created the routine, not an actor who chose to send
  // anything. Without recording the origin, the reply this approval eventually
  // sends is attributed in-app to that owner: every routine-drafted reply read
  // as written by the owner, including to the colleague who approved it (reported
  // 2026-08-05). The run frame exists HERE, at request time, and is gone by the
  // time a human approves, so capture it now.
  const originRoutineId = currentRunContext()?.routineId
  const routineMeta: Record<string, unknown> = originRoutineId ? { originRoutineId } : {}
  // The proposing run's depth travels the same way: a sub-run's gated call,
  // approved later, re-runs outside every frame, and a sub-agent its handler
  // spawns must still nest below that run (MAX_NESTING_DEPTH).
  const liveFrame = currentRunContext()
  // Whether a person was behind the proposing turn (a handler that needs one to
  // act, such as a report only its reporter can send, reads it back when the
  // approval runs it). Only recorded when a frame says so: no frame is a direct
  // call of a person's own.
  if (liveFrame) routineMeta.originHasPerson = runHasPerson(liveFrame)
  const originRun: OriginRun | null =
    opts.originRun !== undefined
      ? opts.originRun
      : liveFrame
        ? {
            runId: liveFrame.runId,
            rootRunId: liveFrame.rootRunId,
            nestingDepth: liveFrame.nestingDepth,
          }
        : null
  if (originRun && originRun.nestingDepth > 0) routineMeta.originRun = originRun
  // The routine RUN that asked, by its frame's root id: the run waits for this
  // approval and resumes once it is decided (routine-run-resume.ts).
  const originRoutineRunId = originRoutineId ? liveFrame?.routineRunId : undefined
  if (originRoutineRunId) routineMeta.originRoutineRunId = originRoutineRunId
  // A47b: which payload paths the schema filled, so the card marks them as defaults rather
  // than showing them as something the agent chose.
  const defaultedMeta: Record<string, unknown> =
    opts.defaultedParams && opts.defaultedParams.length > 0
      ? { defaultedParams: opts.defaultedParams }
      : {}
  // FX4, same reasoning as the routine origin above and captured at the same
  // moment: the approved re-entry runs outside this turn's frame, so the scopes
  // this turn had READ travel on the row. Without them every scope-tagged write
  // the re-entry makes lands untagged and therefore world-readable, while the
  // identical ungated call would have carried the turn's scopes.
  const proposingTurnScopes = resolveProposingTurnScopes(opts.proposingTurnScopes)
  // EVERY APPROVAL A TAINTED TURN CREATES IS NARROWED (scope-taint.ts, rule 13, 2026-11-03).
  // The dispatch names the audience for the writes it judges; a caller that names none (a handler
  // asking for approval itself) still carries what its turn read, so its approval is narrowed to
  // holders of it: notified approvers, decide and edit (`metadata.taintAudienceMustHold`). Only a
  // known, non-empty taint: `[]` read nothing, and an unknowable one (null) is judged by the
  // dispatch before anything parks.
  const audienceMustHold =
    opts.audienceMustHold ??
    (Array.isArray(proposingTurnScopes) && proposingTurnScopes.length > 0
      ? [...new Set(proposingTurnScopes)].sort()
      : [])
  // FX18, captured at the same moment and for the same reason as the two above:
  // this is an action an AGENT took, and the durable audit row must name it.
  const actingAgentId = resolveActingAgentId(opts.actingAgentId)
  const bundleId = opts.bundleId ?? null
  const dependsOnId = opts.dependsOnId ?? null
  const id = opts.id ?? crypto.randomUUID()
  const expiryHours =
    approvalExpiryRegistry.get([orgId, appName, toolShortName]) ?? APPROVAL_DEFAULT_EXPIRY_HOURS
  const now = new Date()
  const expiresAt = new Date(now.getTime() + expiryHours * 3600 * 1000)
  const editableFields = approvalEditableFieldsRegistry.get([orgId, appName, toolShortName]) ?? []
  // Invariant K. For a gated mail send from an encrypted personal mailbox the
  // drafted body and subject are sealed to the mailbox owner HERE, before the
  // payload is written anywhere. Every downstream copy (`tool_params`,
  // `current_payload`, `summaryData`, the durable `pending_events` row below)
  // is then clean BY CONSTRUCTION rather than by a second strip that a future
  // writer could forget. It throws rather than degrading: a ready mailbox with
  // no usable key fails the staging call instead of persisting cleartext.
  const sealedToolParams = await sealMailApprovalPayload({
    orgId,
    appName,
    toolShortName,
    approvalRequestId: id,
    toolParams: (toolParams ?? {}) as Record<string, unknown>,
  })
  const payloadJson = JSON.parse(JSON.stringify(sealedToolParams))

  // Ownership-aware routing (privacy): when the gated tool declares a
  // `resourceOwner` and the targeted resource belongs to a PERSONAL account,
  // the approval routes to the owner alone and is persisted with
  // `resource_owner_id` so decide/edit/list/RLS enforce owner-only visibility.
  //
  // Routine owner as approver (S29): a draft raised by a routine set to
  // `approver: "owner"` routes to the routine owner the same way, on a shared
  // mailbox too, but only when the owner holds the deciding scope (and the
  // turn's taint, since the owner is then its only reader). Otherwise the
  // default deciding-scope audience applies.
  // A personal MCP connection's tool (S16): its owner alone decides, like any
  // other personal resource; the org's approvers never see its calls.
  const resourceOwnerId = await resolveApprovalOwnerRouting({
    orgId,
    appName,
    toolShortName,
    toolParams,
    requestedBy,
    approveScope,
    dimensionConstraint,
    mustHold: audienceMustHold,
    actingAgentId,
  })
  // An N-eyes floor the audience can never meet is refused here, never parked
  // (every caller also checks earlier, before creating any thread).
  await assertApproversAvailable({
    orgId,
    toolName,
    minApprovers: opts.tighten?.minApprovers ?? 1,
    resourceOwnerId,
    approveScope,
    dimensionConstraint,
    mustHold: audienceMustHold,
  })

  // When `bundleId` is set, we wrap the tx in a retry loop: concurrent inserts
  // into the same bundle (READ COMMITTED) can both read MAX(bundle_position) =
  // N and both insert at N+1 — the partial UNIQUE index turns the second into a
  // 23505 unique_violation. We catch and retry with the (now-committed) MAX+1.
  // 5 attempts is more than enough; a step with N parallel calls has ≤N-1
  // possible retries. Standalone (`bundleId === null`) takes attempt 0 and exits.
  const MAX_ATTEMPTS = bundleId !== null ? 5 : 1
  // The agent this row will name, retried once as null if 0071 refuses it. The
  // approval must reach the human even when its proposer no longer exists (see
  // `persistableAgentId`); the event below carries the same value so the audit
  // row cannot name an agent the approval row does not.
  let rowAgentId = persistableAgentId(actingAgentId)
  let agentFallbackUsed = false
  for (let attempt = 0; ; attempt++) {
    try {
      await withPrivilegedDb(orgId, "create-approval-request", async (tx) => {
        const handle = await nextApprovalHandle(tx, orgId)

        // The approval always surfaces on its originating thread. There is no
        // discussion thread for an approval any more: to talk about one, paste
        // its URL into the DM or thread where the conversation belongs.
        // `postDualSystemMessages` already no-ops its second post when
        // threadId === originatingThreadId, so this naturally collapses to a
        // single system message per lifecycle event.
        const approvalThreadId = threadId
        let notifyUserIds: string[] = [requestedBy]

        if (resourceOwnerId) {
          // Personal-resource routing: the gated call targets a personally-owned
          // resource (e.g. a mail reply from a personal mailbox), so the approval
          // goes to the OWNER alone — never the org-wide approver fan-out. The
          // requester is included only when they ARE the owner (the array is then
          // just [owner]); a different requester must not receive the draft body.
          notifyUserIds = [resourceOwnerId]
        } else {
          // Fan out to every eligible approver even when the requester can
          // self-approve. Previously a self-approvable request notified the
          // requester ALONE, so nobody else's feed ever showed it -- three
          // pending skill edits sat invisible to the admin for days
          // (reported 2026-08-06). The requester stays first; the feed's
          // audience rule (notified AND can-decide) keeps noise out.
          // The tool's app decides a restriction, as the approval_requests_select policy does.
          const toolApp = toolName.split(":")[0]
          let approvers = dimensionConstraint
            ? await eligibleApproversWithDimension(
                tx,
                orgId,
                approveScope,
                dimensionConstraint,
                toolApp,
              )
            : await eligibleApprovers(tx, orgId, approveScope, toolApp)
          // A tainted proposal routes only to approvers who hold what its turn read.
          for (const scope of audienceMustHold) {
            const holders = new Set(await eligibleApprovers(tx, orgId, scope))
            approvers = approvers.filter((a) => holders.has(a))
          }
          const seen = new Set<string>([requestedBy])
          notifyUserIds = [requestedBy]
          for (const a of approvers) {
            if (!seen.has(a)) {
              seen.add(a)
              notifyUserIds.push(a)
            }
          }
        }

        // Sub-run rerouting (T8): when this approval is being created from inside
        // an active sub-run (runContextStore frame is set AND parentRunId is set),
        // override the surface thread to the parent run's thread so the approval
        // card appears in the operator's primary thread, not buried in the hidden
        // sub-run thread. Stamp breadcrumb metadata (`runId` / `parentRunId` /
        // `subagentType` / `label`) so the approval card can show "Triggered by
        // sub-run ..." and the operator can drill into the hidden transcript.
        let surfaceThreadId = approvalThreadId
        const subRunMetadata: Record<string, unknown> = {}
        const runFrame = currentRunContext()
        // A7: a gated call made by a turn answering in a REPLY THREAD of this
        // very thread puts its card in that reply thread, and the row keeps the
        // root so every later notice about it (approved, denied, expired,
        // failed) lands there too. Another thread's reply root never applies.
        const replyRootId =
          runFrame?.replyRoot && runFrame.replyRoot.threadId === threadId
            ? runFrame.replyRoot.rootMessageId
            : null
        if (replyRootId) subRunMetadata.replyRootId = replyRootId
        // A sub-run frame (depth > 0): a nested one routes to its parent run's thread, one a chat
        // turn spawned (no parent run row) to the thread that turn ran in (`parent_thread_id`).
        const [thisRun] =
          runFrame && (runFrame.parentRunId || runFrame.nestingDepth > 0)
            ? await tx
                .select({
                  subagentType: agentRuns.subagentType,
                  summary: agentRuns.summary,
                  threadId: agentRuns.threadId, // the sub-run's hidden thread
                  parentThreadId: agentRuns.parentThreadId,
                })
                .from(agentRuns)
                .where(and(eq(agentRuns.id, runFrame.runId), eq(agentRuns.orgId, orgId)))
                .limit(1)
            : []
        if (runFrame && thisRun) {
          const [parentRun] = runFrame.parentRunId
            ? await tx
                .select({ threadId: agentRuns.threadId })
                .from(agentRuns)
                .where(eq(agentRuns.id, runFrame.parentRunId))
                .limit(1)
            : []
          const parentSurface = parentRun?.threadId ?? thisRun.parentThreadId
          if (parentSurface) surfaceThreadId = parentSurface
          subRunMetadata.runId = runFrame.runId
          subRunMetadata.parentRunId = runFrame.parentRunId ?? null
          subRunMetadata.subagentType = thisRun?.subagentType ?? null
          subRunMetadata.label = thisRun?.summary ?? null
          // M8 fix — stamp the hidden thread id on the approval so the card can
          // deep-link directly at the existing `/threads/:id` route (no separate
          // `/runs/:runId` route needed).
          subRunMetadata.hiddenThreadId = thisRun?.threadId ?? null
        }

        // Allocate the next bundle position inside the same tx so the SELECT and
        // INSERT see a consistent snapshot. The partial UNIQUE index on (bundle_id,
        // bundle_position) catches lost-update races; the outer retry loop handles
        // 23505 retries.
        let bundlePosition: number | null = null
        if (bundleId !== null) {
          const posRows = extractRows<{ pos: number }>(
            await tx.execute(drizzleSql`
          SELECT COALESCE(MAX(bundle_position), -1) + 1 AS pos
          FROM ${K}.approval_requests WHERE bundle_id = ${bundleId}`),
          )
          bundlePosition = Number(posRows[0]?.pos ?? 0)
        }

        await tx.insert(approvalRequests).values({
          id,
          orgId,
          handle,
          threadId: surfaceThreadId,
          originatingThreadId: threadId,
          toolName,
          // The SEALED params, not `toolParams`: `tool_params` is a persisted
          // jsonb column exactly like `current_payload`, and Invariant K names
          // both.
          toolParams: sealedToolParams,
          currentPayload: payloadJson,
          expiresAt,
          notifyUserIds,
          requestedBy,
          status: "pending",
          reason,
          summary,
          bundleId,
          bundlePosition,
          dependsOnId,
          resourceOwnerId,
          approveScope,
          dimensionConstraint,
          proposingTurnScopes,
          // A11: the agent whose turn PROPOSED this gated call, persisted at
          // request time. The approved re-entry happens in another request with
          // that turn's frame long gone, so the identity has to travel on the
          // row exactly as the proposing turn's scopes do.
          agentId: rowAgentId,
          // Record the originating surface so the decided execution can stamp the
          // correct bridge actorType (MCP-originated approvals → actorType:"mcp"
          // on the executed mutation; spec C7 / success criterion 7). This can
          // legitimately be "human-ui" here (a genuine direct human click that
          // still got gated, e.g. no approve scope, or an N-eyes policy) — that
          // is safe to persist and safe to replay: executeApprovedToolHandlerInternal
          // forwards it unchanged for the DECIDED mutation's own attribution
          // (correctly resolving to actorType:"user"), and if the replayed
          // handler itself makes a NESTED cross-app call, rpc-bridge.ts's
          // executeTool bridge downgrades "human-ui" to "in-app-agent" for that
          // hop's own ORIGIN, so the nested call never inherits human
          // provenance across the app boundary. That hop still gates unless the
          // target is DECLARED in the caller's `cross_app_calls` — a declared
          // target executes deterministically off the approval itself
          // (`humanAuthorizedCrossAppCall`), which is exactly what stops the
          // outer approval wedging back to pending. See
          // execute-tool-sandbox.test.ts "human-ui OUTER call" (undeclared:
          // still gates) and "approved execution of a GATED outer tool"
          // (declared: executes).
          metadata: {
            ...(origin ? { origin } : {}),
            // The person's message the proposing turn answers, so the turn the
            // approval hands back (approval-result-turn.ts) answers that same
            // ask, not its own trigger (the result row).
            ...(runFrame?.askId ? { askId: runFrame.askId } : {}),
            ...subRunMetadata,
            ...tightenMeta,
            ...routineMeta,
            ...defaultedMeta,
            // Rule 8: who may decide, edit or read the pending body of a tainted proposal,
            // kept on the row for the surfaces widened past `notify_user_ids` (shared-surface
            // drafts, whose readers are the surface's). Read by decide, edit and RLS (0167).
            ...(audienceMustHold.length > 0 ? { taintAudienceMustHold: audienceMustHold } : {}),
            ...(opts.taintDisclosedToReaders === true ? { taintDisclosedToReaders: true } : {}),
            ...(opts.taintDisclosureAudience
              ? { taintDisclosureAudience: opts.taintDisclosureAudience }
              : {}),
          },
        })

        // Who asked, by the one rule every surface reads (an agent, or the
        // person), from the row just written in this transaction.
        const requester = await readApprovalRequester(tx, orgId, id, requestedBy)

        // Greeting: discussion thread (cross-thread only) + originating thread (always).
        // The row is a system line stamped with the requester's user id, so a
        // thread drew it as that person's own post. It carries who asked, by
        // the requester rule (an agent is named as the agent), so the line can
        // read "requested by X" rather than borrow the human's byline.
        const greetingMeta = {
          type: "approval-created",
          requestId: id,
          requesterId: requestedBy,
          requesterKind: requester.kind,
          requesterName: requester.name,
          toolName,
          requestHandle: handle,
        }
        if (approvalThreadId !== threadId) {
          await sendMessage(tx as any, {
            requiredScopes: [],
            orgId,
            userId: requestedBy,
            threadId: approvalThreadId,
            content: `Approval request ${handle} opened.`,
            authorType: "system",
            metadata: greetingMeta,
          })
        }
        await sendMessage(tx as any, {
          requiredScopes: [],
          orgId,
          userId: requestedBy,
          threadId,
          content: `Approval request ${handle} opened.`,
          authorType: "system",
          metadata: greetingMeta,
          replyRootId,
        })

        const summaryData = buildApprovalSummary({
          raw: {
            id,
            handle,
            status: "pending",
            created_at: now,
            expires_at: expiresAt,
            tool_name: toolName,
            approve_scope: approveScope,
            summary,
            current_payload: payloadJson,
            thread_id: surfaceThreadId,
            originating_thread_id: threadId,
            requested_by: requestedBy,
            notify_user_ids: notifyUserIds,
            decided_by: null,
            decided_at: null,
            reason,
            bundle_id: bundleId ?? undefined,
            bundle_position: bundlePosition ?? undefined,
            depends_on_id: dependsOnId ?? undefined,
            resource_owner_id: resourceOwnerId,
            agent_id: rowAgentId,
            metadata: {
              ...(origin ? { origin } : {}),
              ...subRunMetadata,
              ...tightenMeta,
              ...routineMeta,
            },
          },
          requester,
          editableFields,
          lastEdit: null,
        })

        // This writes a DURABLE `kernel.pending_events` row carrying both the
        // summary and the current payload. Invariant K names that table, so do
        // not add a strip here: `summaryData` is assembled from `summary` and
        // `payloadJson`, and both are already content free for an encrypted
        // mailbox (the summariser builds a content-free title, the payload was
        // sealed above). A second filter here would look like the enforcement
        // point and would rot the moment the first one moved.
        await tx.queueEvent({
          app: "kernel",
          entity: "approval_request",
          action: "create",
          entityId: id,
          orgId,
          actorId: requestedBy,
          actorType: "user",
          // A11: the human stays the actor; the agent that proposed the gated
          // call rides alongside so the audit row names it. Same value the row
          // got: `audit_log` carries the same composite FK (0070), so a ghost id
          // here would fail the audit insert instead of the approval one.
          agentId: rowAgentId,
          data: summaryData,
        })
      })
      // Success — break out of the retry loop.
      break
    } catch (err) {
      // Drizzle wraps PG errors in DrizzleQueryError; the original PG code
      // lives on the `cause`. The wrapped message also embeds the inner
      // PG error text, so we detect the bundle-position race by looking for
      // the partial UNIQUE index name in either layer's message — it's the
      // only place that constraint name appears.
      const message = `${String((err as { message?: unknown })?.message ?? "")}|${String(
        (err as { cause?: { message?: unknown } })?.cause?.message ?? "",
      )}`
      if (
        bundleId !== null &&
        attempt < MAX_ATTEMPTS - 1 &&
        message.includes("approval_requests_bundle_unique_position_idx")
      ) {
        // Position-allocation race — recompute MAX+1 on the next attempt.
        continue
      }
      if (attempt < MAX_ATTEMPTS - 1 && isApprovalHandleCollision(err)) continue
      if (!agentFallbackUsed && rowAgentId !== null && isUnknownAgentFkError(err)) {
        // The proposer names no agent of this org (erased mid turn, or invented).
        // Record no agent and stage the approval anyway: the human must still get
        // a card to decide. Costs nothing unless it actually happens.
        agentFallbackUsed = true
        rowAgentId = null
        log.warn(
          { agentId: persistableAgentId(actingAgentId), orgId, toolName },
          "Gated call proposed by an agent that does not exist - staging with no agent",
        )
        continue
      }
      throw err
    }
  }

  // A ROUTINE'S ASK, IN THE CONVERSATION THE ROUTINE POSTS TO (routine-report.ts):
  // the same request drawn as a card there too, after the row is committed so
  // the card can load it. Its handle is read back: the loop above allocates it.
  if (originRoutineId) {
    const [created] = await withPrivilegedDb(orgId, "routine-approval-handle", (tx) =>
      tx
        .select({ handle: approvalRequests.handle })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.id, id), eq(approvalRequests.orgId, orgId)))
        .limit(1),
    )
    const { postRoutineApproval } = await import("~/modules/agent/routines/routine-report")
    await postRoutineApproval({
      orgId,
      routineId: originRoutineId,
      requestId: id,
      handle: created?.handle ?? "",
      toolName,
      requestedBy,
      outputThreadId: threadId,
      requiredScopes: proposingTurnScopes,
    })
  }

  // Schedule expiry job AFTER the row is committed; the conditional UPDATE in the
  // worker keeps a late firing safe and the sweep job catches a missed enqueue.
  try {
    const { enqueueAppJob } = await import("~/infra/jobs/jobs")
    await enqueueAppJob(
      "kernel",
      "approval-expiry",
      { orgId, requestId: id },
      { jobId: `approval-expiry:${id}`, delay: expiresAt.getTime() - Date.now() },
    )
  } catch (err) {
    log.error({ err, requestId: id }, "Failed to enqueue approval-expiry job — sweep will recover")
  }
  return id
}

/** Public, agent-facing wrapper that creates a standalone gated approval and,
 *  optionally, attaches it to the current step's bundle. When `stepBundleId` is
 *  null this behaves exactly like the legacy standalone `createApprovalRequest`
 *  path. When set, the row joins the bundle at the next available
 *  `bundle_position` (atomic under the partial UNIQUE index + retry). */
export async function createApprovalRequestInBundle(args: {
  orgId: string
  threadId: string
  toolName: string
  toolParams: unknown
  requestedBy: string
  summary: ApprovalSummary
  appName: string
  toolShortName: string
  requesterCanApprove: boolean
  origin?: ToolOrigin
  /** Custom decision scope (dimension-constrained approvals). Defaults to derived. */
  approveScope?: string
  /** Optional dimension constraint the decider/audience must cover. */
  dimensionConstraint?: { key: string; values: string[] } | null
  /** Bundle membership: null → standalone (today's behavior). */
  stepBundleId: string | null
  /** The proposing turn's taint: the audience must hold every scope. */
  audienceMustHold?: string[]
}): Promise<string> {
  return createApprovalRequest({
    ...(args.audienceMustHold ? { audienceMustHold: args.audienceMustHold } : {}),
    orgId: args.orgId,
    threadId: args.threadId,
    toolName: args.toolName,
    toolParams: args.toolParams,
    requestedBy: args.requestedBy,
    reason: "gated",
    summary: args.summary,
    appName: args.appName,
    toolShortName: args.toolShortName,
    requesterCanApprove: args.requesterCanApprove,
    origin: args.origin,
    approveScope: args.approveScope,
    dimensionConstraint: args.dimensionConstraint,
    bundleId: args.stepBundleId,
    dependsOnId: null,
  })
}

const K = drizzleSql.raw(schemaRef("kernel"))

/** A bad `@ref:` target — thrown out of the gated block; the message carries the
 *  `invalid_ref` code so callers (and the agent) can branch without chaining. */
function missingRefIds(ids: readonly string[], rows: readonly { id: string }[]): string[] {
  const found = new Set(rows.map((r) => r.id))
  return ids.filter((id) => !found.has(id))
}

function throwInvalidRef(message: string): never {
  const err = new Error(`invalid_ref: ${message}`) as Error & { code: string }
  err.code = "invalid_ref"
  throw err
}

/** Validate every referenced approval, promote any standalone target into a
 *  bundle head, and compute the linkage for a new deferred step. The status
 *  check, head-promotion UPDATEs and siblings-MAX query all run in ONE
 *  transaction with `FOR UPDATE` so a concurrent decideApproval cannot move a
 *  target between the check and the promotion. */
async function resolveBundleForRefs(
  orgId: string,
  threadId: string,
  requesterId: string,
  refs: FoundRef[],
  /** FX18: the acting agent, carried onto the promotion event it queues (A11). */
  actingAgentId: string | null,
): Promise<{ bundleId: string; dependsOnId: string; position: number }> {
  const ids = [...new Set(refs.map((r) => r.approvalId))]
  const idList = drizzleSql.join(
    ids.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`, `,
  )
  return withPrivilegedDb(orgId, "seq-resolve-refs", async (tx) => {
    const rows = extractRows<{
      id: string
      status: string
      tool_name: string
      bundle_id: string | null
      bundle_position: number | null
    }>(
      await tx.execute(drizzleSql`
        SELECT id, status, tool_name, bundle_id, bundle_position
        FROM ${K}.approval_requests
        WHERE org_id = ${orgId} AND id IN (${idList})
          AND originating_thread_id = ${threadId} AND requested_by = ${requesterId}
        FOR UPDATE`),
    )
    if (rows.length !== ids.length) throwInvalidRef(refNotFoundMessage(missingRefIds(ids, rows)))
    for (const r of rows) {
      if (r.status !== "pending" && r.status !== "deferred") {
        throwInvalidRef(refNotChainableMessage(r.id, r.tool_name, r.status))
      }
    }
    // Validate each token's outputKey against the referenced step's declared
    // `referenceableOutputs` — a pasted key that could never resolve is rejected
    // here, as an early retryable error, not as a late whole-bundle cascade
    // failure. Closes the "dumb model gets a token that won't resolve" hole.
    const rowById = new Map(rows.map((r) => [r.id, r]))
    for (const ref of refs) {
      const row = rowById.get(ref.approvalId)
      if (!row) continue // unreachable — rows.length === ids.length asserted above
      const [refApp, refName] = row.tool_name.split(":")
      const declared = toolRegistry.get([orgId, refApp, refName])?.referenceableOutputs ?? []
      if (!declared.includes(ref.outputKey)) {
        throwInvalidRef(
          refUnknownOutputMessage(ref.approvalId, row.tool_name, ref.outputKey, declared),
        )
      }
    }
    // Promote any standalone target into a head; all targets must end in one bundle.
    const bundleIds = new Set<string>()
    const promotedHeadIds: string[] = []
    for (const r of rows) {
      if (r.bundle_id) {
        bundleIds.add(r.bundle_id)
        continue
      }
      await tx.execute(drizzleSql`
        UPDATE ${K}.approval_requests SET bundle_id = id, bundle_position = 0
        WHERE id = ${r.id} AND bundle_id IS NULL`)
      bundleIds.add(r.id)
      promotedHeadIds.push(r.id)
    }
    if (bundleIds.size !== 1) throwInvalidRef(refSpanMessage(ids))
    const bundleId = [...bundleIds][0]
    const siblings = extractRows<{ max: number }>(
      await tx.execute(drizzleSql`
        SELECT COALESCE(MAX(bundle_position), 0) AS max
        FROM ${K}.approval_requests WHERE bundle_id = ${bundleId}`),
    )
    // Depend on the latest-positioned referenced step (linear chains).
    const target = rows.reduce((a, b) =>
      (b.bundle_position ?? 0) >= (a.bundle_position ?? 0) ? b : a,
    )
    // A promoted head's bundle linkage just changed (bundle_id: null → its own
    // id). Emit approval_request:update so any WS client that cached the row
    // from its original create event (bundle_id null) converges — otherwise the
    // card renders as a plain single approval and never shows the stacked
    // bundle steps.
    for (const headId of promotedHeadIds) {
      await queueHeadPromotedEvent(tx, orgId, requesterId, headId, actingAgentId)
    }
    return { bundleId, dependsOnId: target.id, position: Number(siblings[0].max) + 1 }
  })
}

/** Existence + RLS + output-key validation for `@ref` tokens, without the
 *  bundle-promotion side-effects of `resolveBundleForRefs`. Used by the
 *  flag-on parallel-bundling path: the new step's bundle is the agent step's
 *  bundle (allocated by the stream loop), not the source's bundle, so we only
 *  need to verify the refs are valid and collapse to a single source approval.
 *  Throws `invalid_ref` on missing source, wrong status, unknown output key,
 *  or refs spanning more than one source approval. Returns the (single)
 *  source approval id to use as `dependsOnId`. */
export async function validateRefSources(
  orgId: string,
  threadId: string,
  requesterId: string,
  refs: FoundRef[],
): Promise<string> {
  const ids = [...new Set(refs.map((r) => r.approvalId))]
  if (ids.length === 0) throwInvalidRef("No refs to validate")
  if (ids.length > 1) throwInvalidRef(refSpanMessage(ids))
  const idList = drizzleSql.join(
    ids.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`, `,
  )
  return withPrivilegedDb(orgId, "validate-ref-sources", async (tx) => {
    const rows = extractRows<{ id: string; status: string; tool_name: string }>(
      await tx.execute(drizzleSql`
        SELECT id, status, tool_name
        FROM ${K}.approval_requests
        WHERE org_id = ${orgId} AND id IN (${idList})
          AND originating_thread_id = ${threadId} AND requested_by = ${requesterId}`),
    )
    if (rows.length !== ids.length) throwInvalidRef(refNotFoundMessage(missingRefIds(ids, rows)))
    for (const r of rows) {
      if (r.status !== "pending" && r.status !== "deferred" && r.status !== "approved") {
        throwInvalidRef(refNotChainableMessage(r.id, r.tool_name, r.status))
      }
    }
    // Validate each token's outputKey against the referenced step's declared
    // `referenceableOutputs` — pre-empt late cascade failures from typo'd keys.
    const rowById = new Map(rows.map((r) => [r.id, r]))
    for (const ref of refs) {
      const row = rowById.get(ref.approvalId)
      if (!row) continue
      const [refApp, refName] = row.tool_name.split(":")
      const declared = toolRegistry.get([orgId, refApp, refName])?.referenceableOutputs ?? []
      if (!declared.includes(ref.outputKey)) {
        throwInvalidRef(
          refUnknownOutputMessage(ref.approvalId, row.tool_name, ref.outputKey, declared),
        )
      }
    }
    return rows[0].id
  })
}

/** Queue an `approval_request:update` for a standalone approval that was just
 *  promoted to a bundle head, carrying its now-bundled summary. */
async function queueHeadPromotedEvent(
  tx: PrivilegedDb,
  orgId: string,
  actorId: string,
  headId: string,
  /** FX18: the acting agent of the turn doing the promotion (A11). */
  actingAgentId: string | null,
): Promise<void> {
  const [head] = extractRows<{
    handle: string
    status: ApprovalRequestStatus
    created_at: Date
    expires_at: Date
    tool_name: string
    approve_scope: string | null
    summary: ApprovalSummary
    current_payload: Record<string, unknown>
    thread_id: string
    originating_thread_id: string
    requested_by: string
    notify_user_ids: string[]
    decided_by: string | null
    decided_at: Date | null
    reason: string
    bundle_position: number | null
    agent_id: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT ar.handle, ar.status, ar.created_at, ar.expires_at, ar.tool_name, ar.approve_scope,
             ar.summary, ar.current_payload, ar.thread_id, ar.originating_thread_id,
             ar.requested_by, ar.notify_user_ids, ar.decided_by, ar.decided_at,
             ar.reason, ar.bundle_position, ar.agent_id
      FROM ${K}.approval_requests ar
      WHERE ar.id = ${headId}`),
  )
  if (!head) return
  const [hApp, hName] = head.tool_name.split(":")
  const editableFields = approvalEditableFieldsRegistry.get([orgId, hApp, hName]) ?? []
  const summaryData = buildApprovalSummary({
    raw: {
      id: headId,
      handle: head.handle,
      status: head.status,
      created_at: head.created_at,
      expires_at: head.expires_at,
      tool_name: head.tool_name,
      approve_scope: head.approve_scope,
      summary: head.summary,
      current_payload: head.current_payload,
      thread_id: head.thread_id,
      originating_thread_id: head.originating_thread_id,
      requested_by: head.requested_by,
      notify_user_ids: head.notify_user_ids,
      decided_by: head.decided_by,
      decided_at: head.decided_at,
      reason: head.reason,
      bundle_id: headId,
      bundle_position: head.bundle_position ?? 0,
      agent_id: head.agent_id,
    },
    requester: await readApprovalRequester(tx, orgId, headId, head.requested_by),
    editableFields,
    lastEdit: null,
  })
  await tx.queueEvent({
    app: "kernel",
    entity: "approval_request",
    action: "update",
    entityId: headId,
    orgId,
    actorId,
    actorType: "user",
    agentId: actingAgentId,
    data: summaryData,
  })
}

/** Create a `deferred` bundle step. Mirrors createApprovalRequest's INSERT but
 *  sets the bundle columns, copies `thread_id`/`expires_at` from the head, skips
 *  discussion-thread + greeting creation, and enqueues no per-step expiry job
 *  (the head's expiry cascades). Still queues a `create` event so frontend
 *  stores stay consistent. */
export async function createSequencedApprovalStep(args: {
  orgId: string
  threadId: string
  toolName: string
  toolParams: unknown
  requestedBy: string
  summary: ApprovalSummary
  appName: string
  toolShortName: string
  /** THIS step's deciding scope + dimension constraint, resolved from the
   *  step's OWN tool (never copied from the source row — a step's tool_name
   *  differs from its source's, so a copied scope would be the wrong answer
   *  to "what scope decides this approval?"). */
  approveScope?: string | null
  dimensionConstraint?: { key: string; values: string[] } | null
  bundle: { bundleId: string; dependsOnId: string; position: number }
  /** FX13: forwarded by a caller that crossed a frame-losing hop. */
  proposingTurnScopes?: string[] | null
  /** FX18: the acting agent, forwarded by that same caller (A11). */
  actingAgentId?: string | null
}): Promise<string> {
  const id = crypto.randomUUID()
  // Invariant K, as in createApprovalRequest: a sequenced mail send from an
  // encrypted personal mailbox is sealed to the mailbox owner before anything
  // is written. The ciphertext is bound to the row id, so a restage in place
  // (below) seals again for the id of the row it updates.
  const sealStepParams = (approvalRequestId: string) =>
    sealMailApprovalPayload({
      orgId: args.orgId,
      appName: args.appName,
      toolShortName: args.toolShortName,
      approvalRequestId,
      toolParams: (args.toolParams ?? {}) as Record<string, unknown>,
    })
  const sealedToolParams = await sealStepParams(id)
  const payloadJson = JSON.parse(JSON.stringify(sealedToolParams))
  // FX4: captured here, in the proposing turn's frame. A deferred step is
  // executed by the same approved re-entry path as a head, so it needs the same
  // record of what its turn had read.
  const proposingTurnScopes = resolveProposingTurnScopes(args.proposingTurnScopes)
  // FX18: same capture, same moment, so the step's own audit rows name the agent.
  const actingAgentId = resolveActingAgentId(args.actingAgentId)
  // The person's message the proposing turn answers: the bundle's last step
  // hands the turn back (approval-result-turn.ts), so it carries the ask too.
  // Read off the frame, else off the step it depends on.
  const frameAskId = currentRunContext()?.askId
  const editableFields =
    approvalEditableFieldsRegistry.get([args.orgId, args.appName, args.toolShortName]) ?? []
  // Set when an existing deferred step was restaged in place (see below).
  let restagedId: string | null = null

  // Retry the whole tx on bundle-position 23505 (parallel step-bundle inserts).
  // Same envelope as createApprovalRequest above.
  const MAX_ATTEMPTS = 5
  // Same one-shot agent fallback as createApprovalRequest: a step whose proposer
  // no longer exists is staged with no agent rather than not staged at all.
  let rowAgentId = persistableAgentId(actingAgentId)
  let agentFallbackUsed = false
  for (let attempt = 0; ; attempt++) {
    try {
      await withPrivilegedDb(args.orgId, "create-sequenced-step", async (tx) => {
        // RESTAGE-IN-PLACE for deferred steps: a re-run of the same flow (a
        // routine tick replayed, an agent retrying after an upstream fix) whose
        // upstream head DEDUPED onto the existing pending head would otherwise
        // APPEND a sibling step — the human then sees two "reply" steps in one
        // sequence and the older, staler draft still fires on approval. A
        // deferred step is uniquely identified by (bundle, tool, requester,
        // depends_on): when one already exists, update its payload/summary in
        // place instead of inserting a duplicate.
        const [existing] = extractRows<{
          id: string
          metadata: { taintAudienceMustHold?: unknown } | null
        }>(
          await tx.execute(drizzleSql`
        SELECT id, metadata FROM ${K}.approval_requests
        WHERE org_id = ${args.orgId} AND bundle_id = ${args.bundle.bundleId}
          AND tool_name = ${args.toolName} AND requested_by = ${args.requestedBy}
          AND depends_on_id = ${args.bundle.dependsOnId} AND status = 'deferred'
        ORDER BY bundle_position ASC LIMIT 1
        FOR UPDATE`),
        )
        if (existing) {
          const payload = JSON.parse(JSON.stringify(await sealStepParams(existing.id)))
          // FX4: the payload now comes from a LATER turn than the one that
          // first staged this step, and that turn may have read more. The
          // recorded scopes are UNIONED, never replaced, so a restage can only
          // narrow visibility; if either side is unknown the row goes back to
          // NULL, which is the fail-closed branch on re-entry.
          // The step shows to its source's audience (scope-taint.ts, rule 8f), which a
          // later tainted turn may have NARROWED (rule 8g): take the source's audience
          // again and union its demand into the step's, so the new payload never shows
          // to someone the source no longer shows to.
          const [restageSource] = extractRows<{
            metadata: { taintAudienceMustHold?: unknown } | null
          }>(
            await tx.execute(drizzleSql`
        SELECT metadata FROM ${K}.approval_requests WHERE id = ${args.bundle.dependsOnId}`),
          )
          const restageMustHold = [
            ...new Set([
              ...rowTaintMustHold(existing.metadata),
              ...rowTaintMustHold(restageSource?.metadata ?? null),
            ]),
          ].sort()
          await tx.execute(drizzleSql`
        UPDATE ${K}.approval_requests
        SET tool_params = ${JSON.stringify(payload)}::jsonb,
            current_payload = ${JSON.stringify(payload)}::jsonb,
            summary = ${JSON.stringify(args.summary)}::jsonb,
            notify_user_ids = (SELECT s.notify_user_ids FROM ${K}.approval_requests s
                                WHERE s.id = ${args.bundle.dependsOnId}),
            ${
              restageMustHold.length > 0
                ? drizzleSql`metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('taintAudienceMustHold', ${JSON.stringify(restageMustHold)}::jsonb),`
                : drizzleSql``
            }
            ${proposingTurnScopesUnionSql(proposingTurnScopes)}
        WHERE id = ${existing.id}`)
          await tx.queueEvent({
            app: "kernel",
            entity: "approval_request",
            action: "update",
            entityId: existing.id,
            orgId: args.orgId,
            actorId: args.requestedBy,
            actorType: "user",
            agentId: actingAgentId,
            data: { id: existing.id, restaged: true },
          })
          restagedId = existing.id
          return
        }
        const handle = await nextApprovalHandle(tx, args.orgId)

        // Look up the source approval for thread_id / expires_at / notify_user_ids.
        // The notify AUDIENCE is deliberately copied (frozen) from the source:
        // a bundle renders and decides as one unit, and approval rows are
        // frozen snapshots — recomputing per-step audiences after a grant
        // change would make later steps visible to someone who cannot see the
        // head. Decide-time scope reload still prevents a revoked user from
        // deciding. The deciding SCOPE, by contrast, is per-step (see
        // `approveScope` above) — audience and scope are different questions.
        // In the legacy sequenced-bundle path, the source IS the bundle head
        // (`bundle.bundleId === bundle.dependsOnId === head.id`). In the new
        // step-bundle path, `bundle.bundleId` is a fresh UUID for which no row
        // exists yet (this insert may be the very first member), but
        // `bundle.dependsOnId` is the source approval whose outputs we depend on —
        // we can read thread_id / expires_at from it regardless.
        const [source] = extractRows<{
          thread_id: string
          expires_at: string
          notify_user_ids: string[]
          ask_id: string | null
          metadata: { taintAudienceMustHold?: unknown } | null
        }>(
          await tx.execute(drizzleSql`
        SELECT thread_id, expires_at, notify_user_ids, metadata->>'askId' AS ask_id, metadata
        FROM ${K}.approval_requests WHERE id = ${args.bundle.dependsOnId}`),
        )
        const stepAskId = frameAskId ?? source.ask_id ?? null
        // The step shows to its source's audience (notify_user_ids, frozen above), so it
        // demands what that audience was narrowed to (scope-taint.ts, rule 8f).
        const stepMustHold = rowTaintMustHold(source.metadata)
        const stepFrame = currentRunContext()
        const stepRoutine: Record<string, string> = stepFrame?.routineId
          ? {
              originRoutineId: stepFrame.routineId,
              ...(stepFrame.routineRunId ? { originRoutineRunId: stepFrame.routineRunId } : {}),
            }
          : {}

        // Position allocation. If the caller passed -1 we compute MAX(bundle_position)+1
        // inside the same tx (the partial UNIQUE index + outer retry catches races).
        // Legacy callers may still pass an explicit position; preserve that path.
        let bundlePosition: number
        if (args.bundle.position < 0) {
          const posRows = extractRows<{ pos: number }>(
            await tx.execute(drizzleSql`
          SELECT COALESCE(MAX(bundle_position), -1) + 1 AS pos
          FROM ${K}.approval_requests WHERE bundle_id = ${args.bundle.bundleId}`),
          )
          bundlePosition = Number(posRows[0]?.pos ?? 0)
        } else {
          bundlePosition = args.bundle.position
        }

        await tx.insert(approvalRequests).values({
          id,
          orgId: args.orgId,
          handle,
          threadId: source.thread_id,
          originatingThreadId: args.threadId,
          toolName: args.toolName,
          toolParams: sealedToolParams,
          currentPayload: payloadJson,
          expiresAt: new Date(source.expires_at),
          notifyUserIds: source.notify_user_ids,
          requestedBy: args.requestedBy,
          status: "deferred",
          reason: "gated",
          summary: args.summary,
          bundleId: args.bundle.bundleId,
          bundlePosition,
          dependsOnId: args.bundle.dependsOnId,
          approveScope: args.approveScope ?? null,
          dimensionConstraint: args.dimensionConstraint ?? null,
          proposingTurnScopes,
          // A11: as above -- the sequenced step is re-entered on approval too.
          agentId: rowAgentId,
          // A routine run's step carries its routine and run like any of its
          // approvals (createApprovalRequest), so the run waits on it too.
          ...(stepAskId || stepRoutine.originRoutineId || stepMustHold.length > 0
            ? {
                metadata: {
                  ...(stepAskId ? { askId: stepAskId } : {}),
                  ...stepRoutine,
                  ...(stepMustHold.length > 0 ? { taintAudienceMustHold: stepMustHold } : {}),
                },
              }
            : {}),
        })

        const requester = await readApprovalRequester(tx, args.orgId, id, args.requestedBy)

        const summaryData = buildApprovalSummary({
          raw: {
            id,
            handle,
            status: "deferred",
            created_at: new Date(),
            expires_at: new Date(source.expires_at),
            tool_name: args.toolName,
            approve_scope: args.approveScope ?? null,
            summary: args.summary,
            current_payload: payloadJson,
            thread_id: source.thread_id,
            originating_thread_id: args.threadId,
            requested_by: args.requestedBy,
            notify_user_ids: source.notify_user_ids,
            decided_by: null,
            decided_at: null,
            reason: "gated",
            bundle_id: args.bundle.bundleId,
            bundle_position: bundlePosition,
            depends_on_id: args.bundle.dependsOnId,
            agent_id: rowAgentId,
            // The row's routine and run, like a head's event: a listener (a
            // tour step) can tell the step this run proposed from another's.
            metadata:
              stepAskId || stepRoutine.originRoutineId
                ? { ...(stepAskId ? { askId: stepAskId } : {}), ...stepRoutine }
                : null,
          },
          requester,
          editableFields,
          lastEdit: null,
        })

        await tx.queueEvent({
          app: "kernel",
          entity: "approval_request",
          action: "create",
          entityId: id,
          orgId: args.orgId,
          actorId: args.requestedBy,
          actorType: "user",
          // Same value the row got, for the reason given at the head site.
          agentId: rowAgentId,
          data: summaryData,
        })
      })
      break
    } catch (err) {
      const message = `${String((err as { message?: unknown })?.message ?? "")}|${String(
        (err as { cause?: { message?: unknown } })?.cause?.message ?? "",
      )}`
      if (
        attempt < MAX_ATTEMPTS - 1 &&
        (message.includes("approval_requests_bundle_unique_position_idx") ||
          isApprovalHandleCollision(err))
      ) {
        continue
      }
      if (!agentFallbackUsed && rowAgentId !== null && isUnknownAgentFkError(err)) {
        // Proposer names no agent of this org: stage the step with no agent.
        agentFallbackUsed = true
        rowAgentId = null
        log.warn(
          { agentId: persistableAgentId(actingAgentId), orgId: args.orgId },
          "Sequenced step proposed by an agent that does not exist - staging with no agent",
        )
        continue
      }
      throw err
    }
  }
  return restagedId ?? id
}

/**
 * Handler-conditional gating primitive — backs the sandbox `ctx.requestApproval`
 * bridge method (and the in-process equivalent). Unlike declarative `gated: true`
 * (which gates BEFORE the handler runs), this lets a handler decide mid-execution
 * to park for approval — e.g. the invoicing app's per-issuer threshold gate, which
 * can only be evaluated once the handler has loaded the issuer profile.
 *
 * The created approval stores the caller-supplied `tool_name` + `current_payload`.
 * On approve, the kernel's `executeApprovedStep` → `runApprovedToolHandler`
 * re-invokes that tool with `approvalContext` set, so the handler's
 * `if (ctx.approval)` branch skips the gate and completes the action exactly once.
 *
 * `tool_name` must match a registered tool (`<app>:<manifestToolKey>`); the
 * registry keys on the raw manifest tool name. A direct tool call (no conversation
 * thread) gets an auto-created approval thread so the request still surfaces.
 */
export interface HandlerApprovalInput {
  tool_name: string
  summary: string
  /**
   * Optional structured detail for the approval card. Handlers that gate
   * conditionally (invoicing thresholds, social post-backs) previously could
   * only pass a single string, which rendered as a title with EMPTY lines —
   * an operator could not see what they were approving. Bounded and validated
   * like a summarizer result; invalid detail degrades to the string summary.
   */
  summary_detail?: {
    subtitle?: string
    lines?: string[]
    links?: Array<{ label: string; app: string; entityType: string; entityId: string }>
  }
  current_payload: unknown
  editable_fields?: string[]
  /**
   * The handler can carry on at once when the org's auto-approve policy for `tool_name` approves
   * this call (credit notes, purchase orders). The kernel then records the approval as decided by
   * that policy and answers `auto_approved: true`, and the handler proceeds as if approved. A
   * handler that does not set it always parks for a person.
   */
  auto_approvable?: boolean
}

export interface HandlerApprovalResult {
  /** The approval row. Null when the call was granted on the requester's own
   *  authority (`approved_by: "requester"`): no row, no thread. */
  approval_id: string | null
  /** Set when the handler proceeds now: an auto-approve policy approved the
   *  call, or the person whose own call this is holds the deciding scope. */
  auto_approved?: true
  /** Who granted an `auto_approved` call: the org's policy, or the requesting
   *  person themselves (approvals are for agents, not persons). */
  approved_by?: "policy" | "requester"
}

/** Whether the org's auto-approve policy approves a handler-requested approval (see above). */
async function handlerApprovalAutoApproved(a: {
  orgId: string
  toolName: string
  appName: string
  params: unknown
  actor: { scopes: string[]; userId: string; orgId: string }
  threadId?: string
  onApproved: (policyId: string) => Promise<void>
}): Promise<boolean> {
  const tightening = await evaluateApprovalPolicy({
    orgId: a.orgId,
    toolName: a.toolName,
    appName: a.appName,
    params: a.params,
  })
  if (tightening.minApprovers >= 2) return false
  const decision = await evaluateAutoApprove({
    orgId: a.orgId,
    toolName: a.toolName,
    appName: a.appName,
    params: a.params,
    actor: a.actor,
    ...(a.threadId
      ? { untrustedTurn: () => untrustedTurnNeedsApproval(a.threadId as string, a.orgId) }
      : {}),
  })
  if (decision.decision !== "auto_approve" || !decision.policyId) return false
  await a.onApproved(decision.policyId)
  return true
}

export async function createHandlerApprovalRequest(args: {
  orgId: string
  requestedBy: string
  actorScopes: string[]
  defaultAppName: string
  threadId?: string
  origin?: ToolOrigin
  input: HandlerApprovalInput
  /**
   * FX13: forwarded by the sandbox bridge, whose `ctx.requestApproval` callback
   * has lost the proposing turn's frame exactly as `ctx.executeTool` has.
   */
  proposingTurnScopes?: string[] | null
  /** FX18: the acting agent, forwarded across that same hop (A11). */
  actingAgentId?: string | null
  /**
   * The person's OWN scopes, set only when this handler runs as a person's own
   * direct call (origin "human-ui", reached through no cross-app hop). Never
   * an RLS actor: a cross-app hop unions the target app's `*` into it, which
   * would "hold" a deciding scope the person never had. A "human-ui" request
   * without it is refused, never granted and never parked.
   */
  personScopes?: readonly string[]
  /** With `personScopes`: the OUTER tool's own required scopes (the tool the
   *  person called, whose handler asks). They decide a person's request. */
  personToolRequiredScopes?: readonly string[]
  /** The proposing agent run, captured across the sandbox hop (see CreateApprovalRequestOpts). */
  originRun?: OriginRun | null
}): Promise<HandlerApprovalResult> {
  const { input } = args
  const colonIdx = input.tool_name.indexOf(":")
  const appName = colonIdx === -1 ? args.defaultAppName : input.tool_name.slice(0, colonIdx)
  const toolShortName = colonIdx === -1 ? input.tool_name : input.tool_name.slice(colonIdx + 1)
  // A handler parks an approval for one of ITS OWN app's tools. The card's summary is
  // the handler's own text, and approving it runs the named tool, so a handler naming
  // another app's tool would put its words on that tool's card and reach it without
  // the cross-app grant its direct calls need.
  if (appName !== args.defaultAppName) {
    throw new Error(
      `ctx.requestApproval: '${input.tool_name}' is not a tool of '${args.defaultAppName}'; a handler may only request approval for its own app's tools`,
    )
  }
  // A tool whose approval binds pinned params gets them from its preflight only
  // (executeTool's stage path). A handler-built payload would put the
  // handler's own values in their place, unchecked: refused.
  if ((toolRegistry.get([args.orgId, appName, toolShortName])?.pinnedParams ?? []).length > 0) {
    throw new Error(
      `ctx.requestApproval: '${input.tool_name}' declares pinned params, which only its preflight sets; call the tool itself so its preflight pins them`,
    )
  }
  // A handler-parked draft of an outbound message is held to the tool call's own rule: no
  // unfilled placeholder in text a person outside the org reads (outbound-placeholders.ts).
  if (args.origin !== "human-ui") {
    const refusal = await outboundPlaceholderRefusal({
      orgId: args.orgId,
      userId: args.requestedBy,
      params: input.current_payload,
      outboundTextParams: toolRegistry.get([args.orgId, appName, toolShortName])
        ?.outboundTextParams,
    })
    if (refusal) throw new Error(`ctx.requestApproval: ${refusal}`)
  }
  const candidate: ApprovalSummary = {
    kind: toolShortName,
    title: input.summary || toolShortName,
    subtitle: input.summary_detail?.subtitle ?? "Pending approval",
    lines: (input.summary_detail?.lines ?? []).slice(0, 8).map((l) => String(l).slice(0, 200)),
    ...(input.summary_detail?.links ? { links: input.summary_detail.links.slice(0, 10) } : {}),
  }
  // Same validation discipline as registered summarizers: malformed detail
  // (handler bug, sandbox-bridge mangling) degrades to the plain-string form
  // rather than failing the gate.
  const parsed = approvalSummarySchema.safeParse(candidate)
  const summary: ApprovalSummary = parsed.success
    ? parsed.data
    : { kind: toolShortName, title: candidate.title, subtitle: "Pending approval", lines: [] }
  // Pre-generate the approval id so an auto-created surface thread can reference
  // it via `createdFrom` (the thread insert requires it).
  const approvalId = crypto.randomUUID()
  // The TARGET tool's authority, not the currently executing tool's: a
  // handler may stage an approval for a different tool (`input.tool_name`).
  // This path previously hardcoded `<app>:approve` and passed no
  // approveScope/dimensionConstraint at all, so rows it created LOST their
  // custom deciding scope and fanned out to the wrong approvers.
  const { approveScope, dimensionConstraint } = await resolveToolApprovalAuthority({
    orgId: args.orgId,
    appName,
    toolShortName,
    params: input.current_payload,
  })
  const requesterCanApprove =
    hasScope(approveScope, args.actorScopes) &&
    (dimensionConstraint === null ||
      bypassesDimensionConstraint(args.actorScopes) ||
      dimensionGrantCovers(
        await loadActorDimensionGrants(args.orgId, args.requestedBy),
        dimensionConstraint.key,
        dimensionConstraint.values,
      ))
  // The org's N-eyes (two-approver) policy applies to a handler-requested approval exactly as to a
  // gated tool's gate: the parked row carries the floor so decide.ts demands distinct approvers.
  // Tighten-only: a policy that cannot be read leaves the floor at 1 for an agent's request (it
  // parks anyway) and raises it to 2 for a person's own call (which would otherwise run inline).
  let policyDecision: ApprovalPolicyDecision | null = null
  try {
    policyDecision = await evaluateApprovalPolicy({
      orgId: args.orgId,
      toolName: input.tool_name,
      appName,
      params: input.current_payload,
    })
  } catch (err) {
    log.error(
      { err, toolName: input.tool_name, orgId: args.orgId },
      "approval-policy evaluation failed for a handler-requested approval",
    )
  }
  let tighten: CreateApprovalRequestOpts["tighten"] =
    policyDecision && policyDecision.minApprovers >= 2
      ? {
          minApprovers: policyDecision.minApprovers,
          ...(policyDecision.policyId ? { tightenedByPolicy: policyDecision.policyId } : {}),
          ...(policyDecision.reason ? { tightenReason: policyDecision.reason } : {}),
        }
      : undefined
  // Approvals are for agents, not persons. A person's own call (REST/UI) whose handler asks for an
  // approval is decided by the OUTER tool's own permission, on the person's OWN scopes (never the
  // RLS actor, which a cross-app hop widens with the app's `*`): holding the tool's required
  // scopes, the request is granted inline (their click is the decision) and nothing is written;
  // lacking them, it is refused (403). The approve scope plays no part. The exception is an org
  // N-eyes policy: the request parks, the person's click counting as one sign-off when they could
  // decide it, and a further distinct person must approve.
  if (args.origin === "human-ui") {
    const refuse = (kind: PersonRefusal, missing: readonly string[]): never => {
      const refusal = personRefusalError(kind, input.tool_name, missing)
      throw Object.assign(new Error(`forbidden: ${refusal.message}`), {
        code: refusal.code,
        status: refusal.status,
      })
    }
    const personScopes = args.personScopes
    const required = args.personToolRequiredScopes ?? []
    if (!personScopes || args.requestedBy === "system" || required.length === 0) {
      refuse("missing_scope", required)
    }
    const own = personScopes as string[]
    const missing = required.filter((scope) => !hasScope(scope, own))
    if (missing.length > 0) refuse("missing_scope", missing)
    // `@ref` placeholders resolve only in an agent's staged sequence, exactly as
    // the tool gate refuses them on a person's call (`computeSkipGate`).
    if (findRefTokens(input.current_payload).length > 0) refuse("sequenced", [])
    if (!policyDecision) tighten = { minApprovers: 2 }
    if (!tighten) return { approval_id: null, auto_approved: true, approved_by: "requester" }
    // N-eyes: park. The click is a sign-off only from someone who could decide it.
    const personCanDecide =
      hasScope(approveScope, own) &&
      (dimensionConstraint === null ||
        bypassesDimensionConstraint(own) ||
        dimensionGrantCovers(
          await loadActorDimensionGrants(args.orgId, args.requestedBy),
          dimensionConstraint.key,
          dimensionConstraint.values,
        ))
    if (personCanDecide) tighten = { ...tighten, requesterSignedOff: true }
  }
  // An N-eyes floor the audience can never meet is refused before anything is
  // written (no anchor thread, no row), for a person and an agent alike.
  if (tighten && tighten.minApprovers >= 2) {
    try {
      await assertApproversAvailable({
        orgId: args.orgId,
        toolName: input.tool_name,
        minApprovers: tighten.minApprovers,
        resourceOwnerId: await resolveApprovalOwnerRouting({
          orgId: args.orgId,
          appName,
          toolShortName,
          toolParams: input.current_payload,
          requestedBy: args.requestedBy,
          approveScope,
          dimensionConstraint,
          mustHold: [],
        }),
        approveScope,
        dimensionConstraint,
        mustHold: [],
      })
    } catch (err) {
      if (!(err instanceof ApproversUnavailableError)) throw err
      // Deliberate-error shape, so a sandboxed handler surfaces it as a 409.
      throw Object.assign(new Error(`${err.code}: ${err.message}`), {
        code: err.code,
        status: err.status,
      })
    }
  }
  // Resolve a surface thread. A direct tool call (no conversation) has no thread;
  // create a dedicated approval anchor so `approval_requests.thread_id` (NOT
  // NULL) has somewhere to point. `hiddenFromList` because an approval is not a
  // conversation: the row exists for the foreign key, never for a sidebar.
  let threadId = args.threadId
  if (!threadId) {
    threadId = await withPrivilegedDb(args.orgId, "handler-approval-thread", async (tx) => {
      const { thread } = await insertThreadWithParticipants(tx, {
        orgId: args.orgId,
        userId: args.requestedBy,
        participantIds: [args.requestedBy],
        title: `Approval: ${summary.title}`,
        isPinned: false,
        hiddenFromList: true,
        createdFrom: { app: "kernel", entityType: "approval_request", entityId: approvalId },
        type: "approval",
      })
      return thread.id
    })
  }
  // An auto-approve policy answers this call like any gated tool's, when the handler can carry on
  // (`auto_approvable`). Never past a two-person rule, never for a person's own UI click, never
  // for the system actor.
  if (
    input.auto_approvable === true &&
    args.requestedBy !== "system" &&
    (await handlerApprovalAutoApproved({
      orgId: args.orgId,
      toolName: input.tool_name,
      appName,
      params: input.current_payload,
      actor: { scopes: args.actorScopes, userId: args.requestedBy, orgId: args.orgId },
      threadId: args.threadId,
      onApproved: (policyId) =>
        writeSyntheticPolicyApproval({
          id: approvalId,
          orgId: args.orgId,
          threadId: threadId as string,
          toolName: input.tool_name,
          toolParams: input.current_payload,
          requestedBy: args.requestedBy,
          appName,
          policyId,
          proposingTurnScopes: args.proposingTurnScopes,
          actingAgentId: args.actingAgentId,
        }),
    }))
  ) {
    return { approval_id: approvalId, auto_approved: true, approved_by: "policy" }
  }
  const approvalRequestId = await createApprovalRequest({
    orgId: args.orgId,
    id: approvalId,
    threadId,
    toolName: input.tool_name,
    toolParams: input.current_payload,
    requestedBy: args.requestedBy,
    reason: "gated",
    summary,
    appName,
    toolShortName,
    requesterCanApprove,
    approveScope,
    dimensionConstraint,
    origin: args.origin,
    proposingTurnScopes: args.proposingTurnScopes,
    actingAgentId: args.actingAgentId,
    ...(tighten ? { tighten } : {}),
    ...(args.originRun !== undefined ? { originRun: args.originRun } : {}),
  })
  return { approval_id: approvalRequestId }
}

export async function executeToolHandler(
  tool: NonNullable<ReturnType<typeof toolRegistry.get>>,
  handler: NonNullable<ReturnType<typeof toolRegistry.get>>["handler"],
  userId: string,
  orgId: string,
  actorScopes: string[],
  tx: any,
  validatedParams: unknown,
  approvalContext?: {
    approvalRequestId: string
    approvalDeciderId: string
    toolName: string
    approvalExecutionId?: string
    /** Set when the approval was RAISED by a routine tick (captured at request
     *  time, since the run frame is gone by the time a human approves). */
    originRoutineId?: string
  },
  bridgeOptions?: {
    callChain?: string[]
    /**
     * The sandbox EXECUTION this dispatch runs inside, as a per-execution id.
     * It is what bounds one handler's `Promise.all` fan-out: every hop that one
     * execution opens carries its token, and the pool counts them against that
     * token alone.
     *
     * A tool-NAME chain cannot do this job. Two concurrent, independent
     * executions of the same chain produce the same string, so one of them was
     * being demoted to queued work behind the other's fan-out, and the breadth
     * cap counted hops that had no caller in common.
     */
    parentExecutionToken?: string
    taintState?: TaintState
    actor?: ActorContext
    threadId?: string
    origin?: ToolOrigin
    /**
     * Worker-pool scheduling class for the (untrusted-app) sandbox execution.
     * Defaults to "interactive" (a user/agent is waiting). Background dispatchers
     * — event-subscriber handlers, scheduled jobs, routines — pass "background"
     * so they cannot starve foreground tool calls (see worker-pool reservation).
     */
    priority?: ExecPriority
    /**
     * True when this execution is a NESTED dispatch — i.e. the INCOMING
     * `callChain` was non-empty, so some other sandboxed handler is already
     * holding a worker while it waits on this call (cross-app
     * `ctx.executeTool` via rpc-bridge -> executeToolCore).
     *
     * Threaded straight into the worker pool: a nested execution must never
     * queue behind ordinary work, because the slot it would wait for is held by
     * its own caller. See worker-pool.ts's executeNested().
     */
    nested?: boolean
    /**
     * The DECLARED cross-app caller (opts.internalCall.callerApp) when this
     * execution was dispatched app-to-app via ctx.executeTool — undefined for a
     * direct user/agent/MCP call. Lets a target app's bridge distinguish a
     * connector's machine write from an agent-authored one (U5.8: knowledge's
     * placement guard exempts connector-origin document creates, which are
     * filed by the connector's own deterministic convention, not collections).
     */
    callerApp?: string
    /**
     * The caller app when the kernel recognises this dispatch as an INGESTION path
     * (A45, FX22 F6): declared in the caller's own `cross_app_calls` AND named in
     * `CROSS_APP_INGESTIONS`. "" for everything else. Computed by `executeToolCore`
     * (the only place that knows both halves) and read by a handler that may skip an
     * approval gate for a machine write path: it asks for the ingestion, never for
     * "is there any caller app", which every future declaration would inherit.
     */
    ingestionCallerApp?: string
    /** See RpcBridgeOptions.contractFileGrant. */
    contractFileGrant?: readonly string[]
    /** The calling app of a verified provider-contract dispatch (see RpcBridgeOptions). */
    contractCallerApp?: string
    /** The one caller record that dispatch may store a file onto (see RpcBridgeOptions). */
    contractFileTarget?: ContractFileTarget
    /**
     * True when THIS handler runs because a human authorized it with the
     * authority to do so: a direct human-UI call whose clicking user holds the
     * tool's own `<app>:approve` scope. Computed by `executeToolCore` (which is
     * the only place that knows the approve-scope answer) and consumed by
     * rpc-bridge.ts's `executeTool` bridge, which marks a NESTED declared
     * cross-app dispatch `internalCall.humanAuthorized`. The bridge must NOT
     * re-derive this from `origin`: a "human-ui" origin on an UNGATED outer
     * tool proves nothing about the caller's approve authority, so deriving it
     * from origin let a write-only user carry a gate skip into a gated
     * declared target.
     */
    humanAuthorized?: boolean
    /** See ExecuteToolParams.signal. */
    signal?: AbortSignal
    /**
     * FX3-1. The agent acting in this dispatch, already resolved by the caller
     * (`resolveActingAgentId`), forwarded onto the host handler ctx. Host
     * handlers whose rows are keyed BY AGENT rather than by user read it:
     * without it `memory_search` fell back to the caller's `user_id` and a role
     * agent searched the human's memory tree instead of its own.
     */
    actingAgentId?: string | null
    /**
     * The calling turn's scope taint as this dispatch resolved it (`undefined`: no turn
     * called this; the unknown sentinel for an unknowable one), forwarded onto the host
     * handler ctx for a handler that judges part of its own write against a precise
     * audience (`threads_create`'s title and references). It also crosses the sandbox
     * hop, where the handler has no live frame of its own.
     */
    turnTaintScopes?: readonly string[]
    /**
     * The person's OWN scopes, only for a person's own direct call reached
     * through no cross-app hop (see `createHandlerApprovalRequest`). Never the
     * RLS actor's scopes, which a cross-app hop widens with the target's `*`.
     */
    personScopes?: readonly string[]
    /** The calling turn's spawn frame across a sandbox hop (see ExecuteToolParams.spawnParentFrame). */
    spawnParentFrameOverride?: SpawnParentFrame | null
  },
): Promise<unknown> {
  // `tx` is either a live RLS transaction (legacy ambient contract: preflights,
  // post-approval re-entry, atomic tools) or an RlsSession (bridge-owned
  // transactions: the bridge opens a short RLS transaction PER METHOD CALL, so
  // no pool connection is held across sandbox IPC / external I/O).
  const session: RlsSession | null =
    tx && typeof tx.run === "function" && tx.ctx && typeof tx.execute !== "function"
      ? (tx as RlsSession)
      : null

  if (isManifestHandler(handler)) {
    const handlerRef = handler as ManifestHandlerRef
    const manifest = (tool as any)._manifest ?? {
      name: tool.appName,
      schema: {},
      events: {},
      connections: {},
      network: {},
    }
    // Only MCP origin overrides the bridge actorType. undefined preserves the
    // existing default (system-user→"system", else "user") for every non-MCP
    // caller — no behavior change for the in-app agent.
    const bridgeActorType: "mcp" | undefined = bridgeOptions?.origin === "mcp" ? "mcp" : undefined
    // Handler-conditional gating: hand the bridge a `requestApproval` impl bound to
    // this call's actor/thread context. Backs the sandbox `ctx.requestApproval`.
    const requestApprovalImpl = (
      input: HandlerApprovalInput,
      // FX13: the bridge hands over the scopes it captured while the proposing
      // turn's frame was still live. This callback runs in the sandbox hop that
      // lost it, so without them the row records "no turn proposed this".
      proposingTurnScopes?: string[] | null,
      // FX18: and the agent acting in it, captured at the same moment, so the
      // approval this handler parks itself on names the agent that proposed it.
      actingAgentId?: string | null,
      // And the run that turn belongs to, so a sub-run's request, approved
      // later, nests what its handler spawns below that run.
      originRun?: OriginRun | null,
    ) =>
      createHandlerApprovalRequest({
        orgId,
        requestedBy: userId,
        actorScopes,
        defaultAppName: tool.appName,
        threadId: bridgeOptions?.threadId,
        origin: bridgeOptions?.origin,
        input,
        proposingTurnScopes,
        actingAgentId,
        ...(bridgeOptions?.personScopes
          ? {
              personScopes: bridgeOptions.personScopes,
              personToolRequiredScopes: resolveRequiredScopes(tool),
            }
          : {}),
        ...(originRun !== undefined ? { originRun } : {}),
      })
    const bundleSource = await loadBundle(handlerRef.bundlePath)
    // This execution's own identity, handed to the bridge so every cross-app
    // hop it opens is keyed on THIS execution and not on the tool names that
    // led here.
    const executionToken = mintExecutionToken()
    // What this run asks of the outside world, for the tool error of a crash
    // that follows an upstream error answer (upstream-trace.ts).
    const upstreamTrace: UpstreamTrace = {}
    const handlerBridgeOptions = {
      ...bridgeOptions,
      requestApprovalImpl,
      parentExecutionToken: executionToken,
      upstreamTrace,
    }

    // Per-tool sandbox execution budget from the manifest (toolSchema.timeoutMs):
    // fan-out read tools legitimately exceed the tight prod default; undefined
    // falls through to the pool/executor default.
    const toolTimeoutMs = resolveToolTimeoutMs(
      typeof (tool as any).timeoutMs === "number" ? (tool as any).timeoutMs : undefined,
    )
    // A47b: the arguments the HANDLER runs on carry the manifest's declared defaults.
    // On the dispatch path they are already filled (executeToolCore fills them before the
    // policy and the card), so this is the same fill applied twice and adds nothing. It
    // stays because this function is also the APPROVED RE-ENTRY's entry point, which runs
    // from the stored payload and may predate the fill, and because a fill is idempotent:
    // a value that is present is never replaced.
    const handlerParams = withManifestDefaults(tool, validatedParams)
    const runManifest = (bridge: Record<string, any>, holdsTx: boolean): Promise<unknown> =>
      runManifestOnce(bridge, holdsTx).catch((err: unknown) => {
        attachUpstreamTrace(err, upstreamTrace)
        throw err
      })
    const runManifestOnce = (bridge: Record<string, any>, holdsTx: boolean): Promise<unknown> =>
      runApp({
        trusted: handlerRef.trusted === true,
        appName: tool.appName,
        orgId,
        bundlePath: handlerRef.bundlePath,
        bundleSource,
        exportName: handlerRef.exportName,
        params: handlerParams,
        bridge,
        executionToken,
        timeoutMs: toolTimeoutMs,
        signal: bridgeOptions?.signal,
        holdsTx,
        // The fields below reach the worker pool only (the in-process executor
        // takes none of them).
        // K6 — thread the post-approval re-entry signal to the worker so the shim
        // can bake `ctx.approval` as a synchronous literal (the async
        // `_approvalContext_get` bridge can't satisfy the sync `if (ctx.approval)`
        // branch untrusted handlers use to gate on first-entry vs re-entry).
        syncContext: { approval: approvalContext ?? null },
        priority: bridgeOptions?.priority ?? "interactive",
        // Reentrancy admission: a dispatch whose call chain already holds
        // another tool is running INSIDE a sandbox execution (a cross-app
        // ctx.executeTool hop), and the caller is blocked on a worker of this
        // same pool until it answers. The pool must not park it behind that
        // caller: it admits it above maxSize instead of queueing it into a
        // deadlock. `bridgeOptions.nested` is the flag executeToolCore plumbs
        // in from the INCOMING chain; the callChain derivation is the same
        // fact read at this site (the current tool is already pushed here),
        // and is kept so a caller that does not plumb the flag is still
        // admitted rather than deadlocked.
        nested: bridgeOptions?.nested === true || (bridgeOptions?.callChain?.length ?? 0) > 1,
        // Every hop of one handler's `Promise.all` fan-out carries the same
        // PARENT EXECUTION token, so this keys them together and the pool can
        // bound that fan-out's breadth instead of letting it jump the queue
        // without limit. A hop opened by another execution of the same chain
        // carries a different token and gets its own breadth.
        nestedParentKey: bridgeOptions?.parentExecutionToken,
        appId: tool.appName,
        toolName: tool.name,
      })

    if (session && (tool as any).atomic !== true) {
      // Bridge-owned transactions: NO ambient transaction is open while the
      // sandbox runs; each bridge method call acquires its own short RLS tx.
      return runManifest(
        createSessionRpcBridge(
          tool.appName,
          userId,
          orgId,
          session,
          manifest,
          actorScopes,
          bridgeActorType,
          approvalContext,
          handlerBridgeOptions,
        ),
        false,
      )
    }
    if (session) {
      // `atomic: true` tool: legacy whole-run ambient transaction, materialized
      // from the session (its failure paths rely on whole-run rollback).
      return session.run((liveTx) =>
        runManifest(
          inlinePgCauseOnBridge(
            createSandboxRpcBridge(
              tool.appName,
              userId,
              orgId,
              liveTx,
              manifest,
              actorScopes,
              bridgeActorType,
              approvalContext,
              handlerBridgeOptions,
            ),
          ),
          true,
        ),
      )
    }
    return runManifest(
      inlinePgCauseOnBridge(
        createSandboxRpcBridge(
          tool.appName,
          userId,
          orgId,
          tx,
          manifest,
          actorScopes,
          bridgeActorType,
          approvalContext,
          handlerBridgeOptions,
        ),
      ),
      true,
    )
  }

  // Provenance: actorType is derived from bridgeOptions.origin (human-ui | in-app-agent
  // | mcp | system); approverUserId is set by the gated-approval re-entry path (when
  // an approver decides a previously-blocked call). Direct UI/API calls default to
  // actorType:'user', approver=null.
  //
  // This ctx.actorType feeds `createdByActorType` on skills/routines and similar
  // "who does the UI show as the author" columns, which carry a DB CHECK constraint
  // of IN ('user','agent','mcp') (see db/schema/kernel/{skills,routines}.ts) — there
  // is no 'system' bucket at this layer. "system" (webhook/job/routine-tick, no
  // re-entrant origin) is therefore an EXPLICIT arm rather than an accidental fall
  // through the "human-ui"/undefined catch-all: it still resolves to 'user' (the
  // acting context's own actorType), same value as before, but now for a reasoned,
  // documented reason instead of by omission.
  const actorType: "user" | "agent" | "mcp" =
    bridgeOptions?.origin === "mcp"
      ? "mcp"
      : bridgeOptions?.origin === "in-app-agent"
        ? "agent"
        : bridgeOptions?.origin === "system"
          ? "user" // no human, no agent, no MCP client; DB constraint has no 'system' bucket here
          : "user" // "human-ui" or genuinely undefined: a direct call, the human IS the author
  const approverUserId = approvalContext ? approvalContext.approvalDeciderId : null
  // A routine executes as its OWNER, so the owner's name is the WRONG in-app
  // author for anything a routine drafted. Prefer the approval's recorded origin
  // (a gated send approved later, when the run frame no longer exists); fall
  // back to the live frame for a direct, ungated routine call.
  const originRoutineId = approvalContext?.originRoutineId ?? currentRunContext()?.routineId
  const runHostHandler = (liveTx: any): Promise<unknown> => {
    const ctx = createAppContext(
      tool.appName,
      userId,
      orgId,
      liveTx,
      actorType,
      approverUserId,
      bridgeOptions?.actor,
    )
    // Inject the actor's effective scopes for handlers that perform scope-subset /
    // privilege checks (e.g. kernel:create_skill checks ctx.scopes against the
    // requested requiredScopes). Handlers that don't read .scopes simply ignore it.
    ctx.scopes = actorScopes
    // The routine this call came from, when it came from one. Handlers that
    // record an author use it to attribute the work to the ROUTINE rather than
    // to the human who happens to own it.
    ctx.originRoutineId = originRoutineId
    // The agent's execution thread — used to attribute agent thread posts
    // ("{User}'s agent" vs "Routine {name}"). Undefined for non-agent callers.
    ctx.agentExecutionThreadId = bridgeOptions?.threadId
    ctx.approvalRequestId = approvalContext?.approvalRequestId
    // FX3-1: the acting agent, for handlers keyed by agent rather than by user.
    // Absent (a caller that never resolved one) falls back to the live frame,
    // which is what an in-frame host handler had before this field existed.
    ctx.actingAgentId =
      bridgeOptions?.actingAgentId !== undefined
        ? bridgeOptions.actingAgentId
        : captureActingAgentId()
    ctx.turnTaintScopes = bridgeOptions?.turnTaintScopes
    // The caller's stop (a turn stopped by the person): a handler that waits on long work it
    // started (spawn_agent awaiting its sub-run) ends that work with it.
    ctx.abortSignal = bridgeOptions?.signal
    return (handler as (params: unknown, ctx: any) => Promise<unknown>)(validatedParams, ctx)
  }
  // Host-side (non-sandboxed) handlers keep the whole-run ambient transaction:
  // they execute in-process against the live tx, so per-call sessions buy
  // nothing and would change their rollback semantics.
  if (session) return session.run(runHostHandler)
  return runHostHandler(tx)
}

/**
 * A gated tool's preflight has already resolved the records the call names, so
 * it may hand back the canonical form of an identifier the caller passed as an
 * alias (a `ticket-<n>` handle for the ticket uuid) as
 * `{ ok: true, canonicalParams: { ticketId: "<uuid>" } }`. The approval then
 * stores, dedupes, lists and links by that canonical id: an approval staged by
 * handle otherwise kept the handle in its payload and in its "Open ticket"
 * link, which resolves entity ids as uuids and opened nothing.
 *
 * Only a top-level param the caller already set to a non-empty string can be
 * replaced, and only by a non-empty string: a preflight canonicalises an
 * identifier, it never adds, drops or retypes a param.
 *
 * Separately, an `ok: true` result may PIN server-derived params
 * (`pinnedParams: { key: value }`): each is set on the staged call whatever
 * the caller passed under that key, so the approval card and the execution
 * read the server's value, never the caller's (api-connector's
 * `connector_write` pins the method, host, path and adapter version it was
 * approved on, and its handler refuses when they no longer hold). A tool
 * declares each pinned key in its params schema.
 */
/**
 * A preflight's `{ ok: true, noAutoApprove: true }`: this call, for these params, is decided by a
 * person, exactly like a tool declared `noAutoApprove` (computeSkipGate). No auto-approve policy
 * and no capability arm answers it. For a tool whose need for a person depends on the data (an
 * invoicing app refusing to let an agent's own word on a buyer's status through unseen). It can
 * only ADD the requirement: a preflight never removes a gate.
 */
export function preflightRequiresPerson(preflightResult: unknown): boolean {
  return (
    typeof preflightResult === "object" &&
    preflightResult !== null &&
    (preflightResult as { ok?: unknown }).ok === true &&
    (preflightResult as { noAutoApprove?: unknown }).noAutoApprove === true
  )
}

export function applyPreflightCanonicalParams(params: unknown, preflightResult: unknown): unknown {
  if (typeof preflightResult !== "object" || preflightResult === null) return params
  if (typeof params !== "object" || params === null || Array.isArray(params)) return params
  const pinned = preflightPinnedParams(preflightResult)
  const base = pinned ? { ...(params as Record<string, unknown>), ...pinned } : params
  const canonical = (preflightResult as { canonicalParams?: unknown }).canonicalParams
  if (typeof canonical !== "object" || canonical === null || Array.isArray(canonical)) {
    return base
  }
  const current = base as Record<string, unknown>
  let next: Record<string, unknown> | null = null
  for (const [key, value] of Object.entries(canonical as Record<string, unknown>)) {
    if (typeof value !== "string" || value.length === 0) continue
    const was = current[key]
    if (typeof was !== "string" || was.length === 0 || was === value) continue
    next ??= { ...current }
    next[key] = value
  }
  return next ?? base
}

function preflightPinnedParams(result: object): Record<string, unknown> | null {
  if ((result as { ok?: unknown }).ok !== true) return null
  const pinned = (result as { pinnedParams?: unknown }).pinnedParams
  if (typeof pinned !== "object" || pinned === null || Array.isArray(pinned)) return null
  return pinned as Record<string, unknown>
}

/**
 * The HTTP class of a deliberate refusal (`refuseTool()` in @liaison/app-sdk: `refusal: true` in
 * the returned error envelope). A guard that declined the call on purpose and told the caller how
 * to fix it is an expected outcome, never a server fault: it is always a 4xx, so the agent bridge
 * logs it at warn and the watchdog does not page. Its own 4xx status wins, then the code's mapped
 * 4xx, then 422. A refusal can never claim a 5xx; an unmarked error keeps the code map.
 */
function refusalStatus(code: string, declared: unknown): number {
  const isClientClass = (s: unknown): s is number =>
    typeof s === "number" && Number.isInteger(s) && s >= 400 && s < 500
  if (isClientClass(declared)) return declared
  const mapped = statusForToolError(code)
  return isClientClass(mapped) ? mapped : 422
}

function normalizeToolErrorResult(result: unknown): ExecuteToolError | null {
  if (typeof result !== "object" || result === null || !("error" in result)) return null
  const error = (result as { error?: unknown }).error
  if (typeof error === "object" && error !== null) {
    const e = error as {
      code?: unknown
      message?: unknown
      retryable?: unknown
      status?: unknown
      body?: unknown
      refusal?: unknown
    }
    const code = typeof e.code === "string" ? e.code : "tool_error"
    const status =
      e.refusal === true
        ? refusalStatus(code, e.status)
        : typeof e.status === "number"
          ? e.status
          : undefined
    return {
      code,
      message: typeof e.message === "string" ? e.message : "Tool returned an error",
      retryable: typeof e.retryable === "boolean" ? e.retryable : false,
      ...(status !== undefined ? { status } : {}),
      ...(e.body !== undefined ? { body: e.body } : {}),
    }
  }
  if (typeof error === "string") {
    return { code: "tool_error", message: error, retryable: false }
  }
  return { code: "tool_error", message: "Tool returned an error", retryable: false }
}

/**
 * "Nothing is connected yet" is a NORMAL state of a fresh install, not a
 * server fault. A connector answers it with the structured
 * `{ error: { code: "<platform>_not_connected", message } }` envelope, and
 * turning that into HTTP 500 left every app dashboard unable to tell an
 * outage from an empty workspace: the ads board printed "One or more panels
 * could not load" on a deployment where nothing had ever been connected.
 * The envelope rides back as the tool's ANSWER instead, with a 200.
 */
export function isNotConnectedToolErrorCode(code: string): boolean {
  return code === "not_connected" || code.endsWith("_not_connected")
}

export function statusForToolError(code: string): number {
  switch (code) {
    case "invalid_params":
    case "invalid_ref":
    case "invalid_transition":
    case "converted_ticket":
    case "merged_ticket":
    case "merge_self_reference":
    case "ticket_already_merged":
    case "merge_target_invalid":
    case "category_depth_limit":
    case "archived_category":
    case "archived_inbox":
    case "inbox_email_taken":
    case "followup_in_past":
    case "not_in_awaiting_followup":
    case "invalid_cursor":
    // A team filter/rename naming a team that does not exist is a BAD ARGUMENT
    // — the caller passed a label nobody uses, usually a trimmed or re-cased
    // version of a real one. Without this it fell through to the default 500,
    // so the tool result read like a server fault (and paged the watchdog)
    // instead of the actionable "here are the real labels" the message carries.
    // Applies to tickets:backlogHealth and tickets:teams.rename alike.
    case "unknown_team":
    // The knowledge placement guard's BAD-ARGUMENT refusals (no collection
    // named, a collection that does not exist, no sensitivity, a malformed
    // share entry). Each message carries what the caller must pass instead,
    // so answering 500 turned actionable guidance into a server fault.
    case "collection_required":
    case "collection_not_found":
    case "sensitivity_required":
    case "invalid_share":
    case "access_rules_required":
    // database connector: a `connection` param naming no known connection.
    case "unknown_connection":
    // database connector: db_read naming a read the catalog does not declare
    // (the error lists the valid names).
    case "unknown_read":
      return 400
    case "forbidden":
    // A scope the caller does not hold is an AUTHORIZATION refusal, not a
    // server fault. Since gated tools preflight BEFORE staging, this is the
    // status an agent-initiated knowledge:create without
    // knowledge:collections:manage answers with, and a bare 500 there both
    // misread as a fault and paged the watchdog.
    case "collections_scope_required":
    // database connector: raw queries are switched off for this deployment; the
    // message points to the curated reads instead.
    case "disabled":
      return 403
    // The app is turned Off for the workspace (S19): a conflict with the
    // workspace's state, not a fault and not a missing permission.
    case APP_DISABLED_CODE:
      return 409
    case APP_STATE_UNAVAILABLE_CODE:
      return 503
    case "tool_not_found":
    case "not_found":
    // The kernel contact tools' spelling (contact-tools.ts).
    case "NOT_FOUND":
    case "ticket_not_found":
      return 404
    case "idempotency_conflict":
      return 409
    case "idempotency_in_flight":
      return 409
    // BL-266: a compare-and-swap claim that lost the race (tickets:assign with
    // onlyIfUnassigned/expectedAssignee, ticket already owned) is a precondition
    // conflict, not a server error — surface 409 so the agent reads it as a
    // typed "already taken" outcome and skips, never a 500/"tool failed".
    case "conflict":
      return 409
    // database connector: the stored connection or adapter configuration is
    // unusable (both credential modes set, a malformed DSN, a bad dialect). An
    // administrator's fix, not a server fault: it must not page the watchdog.
    case "config_error":
      return 409
    // A connection with no stored credentials: the person reconnects it.
    case CONNECTION_CREDENTIALS_MISSING:
      return 422
    case "call_chain_limit":
      return 400
    // Caller-context mistake (e.g. spawn_agent invoked outside an agent
    // execution thread) — a client-side error, not a server fault.
    case "invalid_context":
    // threads_reply aimed at the thread the turn is answering (chat-tools.ts):
    // the turn's own answer posts there when it ends, so the call is refused.
    case "answering_thread":
      return 400
    default:
      // A bundled app's own deliberate codes (tool-error-status.ts).
      return APP_TOOL_ERROR_STATUS[code] ?? 500
  }
}

/**
 * executeToolCore — non-throwing pipeline for cross-app tool dispatch.
 * Returns an envelope that is either { data }, { blocked }, or { error }.
 * Used by the sandbox bridge (cross-app calls) and by the HTTP `executeTool` wrapper.
 */
/** True when the approval row is routed to `userId` as its resource owner. */
async function approvalOwnedBy(
  orgId: string,
  approvalRequestId: string | null,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!approvalRequestId || !userId) return false
  const rows = await withPrivilegedDb(orgId, "approval-owner-check", (tx) =>
    tx.execute(drizzleSql`
      SELECT 1 FROM ${K}.approval_requests
       WHERE id = ${approvalRequestId}::uuid AND resource_owner_id = ${userId}::uuid`),
  )
  return extractRows(rows).length > 0
}

export async function executeToolCore(opts: ExecuteToolCoreOptions): Promise<ExecuteToolEnvelope> {
  const callChain = opts.callChain ?? []
  // A non-empty INCOMING chain means this dispatch was made from inside another
  // app's handler, which is still holding its sandbox worker while it awaits
  // this call. The worker pool needs to know (see worker-pool.ts executeNested).
  // Note `kernel:*` targets are host tools and never take a worker at all, so
  // the flag is simply ignored for them.
  const isNestedDispatch = callChain.length > 0
  if (callChain.length >= 5 || callChain.includes(opts.toolName)) {
    return {
      error: {
        code: "call_chain_limit",
        message: `call chain limit exceeded: ${[...callChain, opts.toolName].join(" -> ")}`,
        retryable: false,
      },
    }
  }

  const colonIdx = opts.toolName.indexOf(":")
  if (colonIdx === -1) {
    return {
      error: { code: "invalid_params", message: "Invalid tool name format", retryable: false },
    }
  }
  const appName = opts.toolName.slice(0, colonIdx)
  const name = opts.toolName.slice(colonIdx + 1)

  // Another org's custom app does not exist for this org (app-org-scope.ts):
  // the same answer as an unknown tool, before any registry is read.
  if (!(await appVisibleToOrg(appName, opts.orgId))) {
    return {
      error: {
        code: "tool_not_found",
        message: `tool ${opts.toolName} not registered`,
        retryable: false,
      },
    }
  }

  let tool = toolRegistry.get([opts.orgId, appName, name])
  if (!tool) {
    const defaultApps = await getDefaultApps()
    if (!defaultApps.some((app) => app.name === appName)) {
      return {
        error: {
          code: "tool_not_found",
          message: `tool ${opts.toolName} not registered`,
          retryable: false,
        },
      }
    }
    await ensureAppsForOrg(opts.orgId)
    tool = toolRegistry.get([opts.orgId, appName, name])
  }
  if (!tool) {
    return {
      error: {
        code: "tool_not_found",
        message: `tool ${opts.toolName} not registered`,
        retryable: false,
      },
    }
  }
  // Where THIS call writes, when that depends on the org's state (`taintSinkFor`): the
  // scope-taint judgement below reads the sink of this call, never a stale static one.
  if (tool.taintSinkFor) {
    const sink = await tool.taintSinkFor({ orgId: opts.orgId })
    if (sink) {
      tool = {
        ...tool,
        writesToTable: sink.writesToTable,
        sinkReadScope: sink.sinkReadScope,
        sinkReadersSelf: sink.sinkReadersSelf,
      }
    }
  }

  // A personal MCP connection's tools belong to its owner alone (S16), whoever
  // asks: an admin's `*` covers every mcp:<slug> scope, so without this another
  // user could stage (and an approver run) a call on the owner's account. The
  // tool lists already leave them out; a call by name meets the same answer.
  const callerUserId = (opts.actor as { userId?: string | null }).userId ?? null
  if (tool.ownerUserId && callerUserId !== null && tool.ownerUserId !== callerUserId) {
    return {
      error: {
        code: "tool_not_found",
        message: `tool ${opts.toolName} not registered`,
        retryable: false,
      },
    }
  }

  // AN APP TURNED OFF (or removed) FOR THE WORKSPACE (S19, A6) runs nothing,
  // whoever asks: the human UI, an agent, a routine, a job, a webhook, an
  // approved re-entry or another app's cross-app call. Checked against the
  // persisted per-org state (load-on-miss), and fail-closed: a state that
  // cannot be read refuses instead of running.
  if (appName !== "kernel") {
    let active: boolean
    try {
      active = await isAppActiveForOrgAsync(opts.orgId, appName)
    } catch (err) {
      log.error(
        { err, orgId: opts.orgId, tool: opts.toolName },
        "app state unreadable; refusing the call",
      )
      return {
        error: {
          code: APP_STATE_UNAVAILABLE_CODE,
          message: "The workspace's app state could not be read; try again.",
          retryable: true,
        },
      }
    }
    if (!active) {
      return { error: { code: APP_DISABLED_CODE, message: APP_DISABLED_MESSAGE, retryable: false } }
    }
  }

  // A READ-ONLY RUN (the Share anyway rerun, spec-security.md D4) may dispatch a
  // READ and nothing else, here as well as in the tool bridge: this is the entry
  // every cross-app and nested dispatch passes through, including the sandbox
  // bridge's `ctx.executeTool`, which the bridge's own catalog never filters.
  //
  // The mark is the RUN's, taken from the live frame or from the capture a
  // caller made before a hop that loses it, never from the `readOnly` marker of
  // the tool that got us here: that marker is written by the app's own manifest,
  // so a manifest that lies about a writing tool must not be able to buy itself
  // a write. What the marker still decides is which TARGET is a read, exactly as
  // the rerun's catalog decides it, and an undeclared target counts as a write,
  // so this fails closed.
  if (opts.readOnlyRun === true || captureReadOnlyRun()) {
    const blocked = checkReadOnlyRun(tool)
    if (blocked) {
      log.warn(
        { toolName: opts.toolName, writeTargetTable: blocked.writeTargetTable },
        "Tool dispatch refused: this run may not write",
      )
      return {
        error: {
          code: blocked.code,
          message: `tool ${opts.toolName} would write (${blocked.writeTargetTable}) and this run may only read`,
          retryable: false,
        },
      }
    }
  }

  // SCOPE TAINT ON WRITES (A3, spec-security.md "Scope taint on writes"): the
  // write-path half of the same boundary as the read-only-run check above.
  //
  // The tool bridge already refuses a tainted turn's write in its execute
  // closure. That closure sees only the calls the CHAT turn makes: a cross-app
  // `internalCall`, a nested dispatch, the sandbox bridge's `ctx.executeTool`
  // and an approved re-entry all arrive here without passing through it, so the
  // guard sits at this entry too, exactly as the read-only boundary does. Both
  // layers delegate to the same `checkScopeTaint` and the same
  // `TAINT_ENFORCING_SINKS`, so a chat call checked twice cannot be answered
  // two ways.
  //
  // The taint is the RUN's, never the tool's: the snapshot from before the
  // running call recorded its own scope (a write tool's own scope is not a data
  // read), else the accumulator as it stands. The tool's own marker decides only
  // which TARGET is a write, and an undeclared target counts as a write, so this
  // fails closed.
  //
  // NO FRAME AT ALL evaluates no taint, and that is the honest answer rather
  // than a hole: a human request, a job, a cron, a webhook and the MCP gateway
  // (which opens no frame and reaches here straight through `executeTool`) have
  // no turn behind them, so there is nothing that could have been read.
  //
  // A FRAME THAT CARRIES NO ACCUMULATOR is the unknown case and fails CLOSED.
  // It was once allowed on the belief that routine ticks reach this boundary
  // that way. One caller DOES build such a frame: `routine-worker.ts` opens a
  // tick frame carrying only `routineId`. It never arrives here, because the
  // tick runs through `runAgentChat`, which mints its own frame WITH an
  // accumulator, and that inner frame is what the tool bridge re-enters around
  // every call, shadowing the tick's. Sub-runs, approved re-entries and the
  // sandbox hop all carry one too (the hop forwards it explicitly). So no
  // accumulator-less frame reaches this boundary today -- by shadowing, not
  // because nobody builds one -- and one that did would mean the turn's taint
  // is simply unknowable, resolved to the worst case exactly as every other
  // unknown taint is.
  //
  // ACROSS A HOP THAT LOSES THE FRAME the taint travels with the caller (FX12),
  // exactly as the read-only mark above does. A sandboxed app's `ctx.executeTool`
  // callback runs in a worker-pool hop where `currentRunContext()` is undefined,
  // so the in-frame read alone answered "no turn" and evaluated no taint at all,
  // and a tainted turn could launder its reads into a non-enforcing table by
  // routing the write through a sandboxed app. The forwarded value wins when the
  // caller supplies one: it is the only witness of the calling turn left.
  const taintFrame = currentRunContext()
  const inFrameTaintScopes = taintFrame
    ? taintFrame.turnScopeAccumulator
      ? (currentToolCallScopesBefore() ?? taintFrame.turnScopeAccumulator.snapshot())
      : null
    : undefined
  const turnTaintScopes =
    opts.turnTaintScopes !== undefined ? opts.turnTaintScopes : inFrameTaintScopes
  // The same taint, normalized (an unreadable value is the unknown sentinel), for the handler.
  const handlerTurnTaint: string[] | undefined =
    turnTaintScopes === undefined
      ? undefined
      : Array.isArray(turnTaintScopes) && turnTaintScopes.every((s) => typeof s === "string")
        ? turnTaintScopes
        : [...UNKNOWN_TURN_TAINT]
  // SAME-RESOURCE ALLOWANCE (A46). The origin rows travel with the taint: the live
  // frame's accumulator in frame, and the store forwarded by the caller across a hop
  // that lost it (the sandbox bridge), exactly as the scopes above are. It is read
  // LIVE, so a read made earlier in this same hop already counts.
  const taintOriginStore: TaintOriginStore | undefined =
    opts.turnTaintOrigins ?? taintFrame?.turnScopeAccumulator
  const turnTaintOriginRows = taintOriginStore?.originRows()
  // FX18 (A11): resolved ONCE for this dispatch, from the forwarded value when
  // the caller crossed the sandbox hop and from the live frame otherwise, so
  // every approval row this dispatch records names the same agent.
  const actingAgentId = resolveActingAgentId(opts.actingAgentId)
  // A TAINTED GATED WRITE PARKS INSTEAD OF BEING REFUSED (scope-taint.ts, consequence 2),
  // when everyone its approval will be shown to holds every scope the turn read. Set here, read
  // by the gating block below: it forces the approval (no auto-approve, no inline run) and
  // narrows the notify audience to approvers holding these scopes.
  let taintForcedApprovalScopes: string[] | null = null
  // Set with it when people who can read where the write lands lack those scopes (rule 8): the
  // card then says approving discloses the turn's data to them.
  let taintDisclosedToReaders = false
  // Set with it for an agent post some of its readers could not see (rule 11): how many (null
  // when they could not be counted). The card then names them as this conversation's people.
  let taintPostHiddenFrom: number | null | undefined
  // With it, the people the post would reach when it parked (rule 11b): its disclosure audience.
  let taintPostSnapshot: string[] | undefined
  // What a judged tainted turn read, whatever the sink check answered (rule 13, 2026-11-03): a
  // write the taint lets through (an enforcing sink such as memory, readers who hold it, the
  // same-resource allowance) can still park for another reason (the outside-content hold, a host
  // gate, a gated tool, an org policy), and its approval carries the turn's data as surely as a
  // taint-forced one. Null when the turn is not judged (no taint, a read, a web read, ...).
  let judgedTurnTaint: string[] | null = null
  // An approved outer action's declared cross-app call is part of executing what a person
  // decided; its taint is that approval's, and the approval was staged only for an audience
  // holding it. Refusing it here wedged the approval back to pending.
  const approvalExecutingNestedCall =
    opts.internalCall?.humanAuthorized === true &&
    opts.internalCall.humanAuthorizedVia === "approval" &&
    opts.internalCall.callerApp != null &&
    (
      appCrossAppCallsRegistry.get([opts.orgId, opts.internalCall.callerApp])?.targets ?? []
    ).includes(opts.toolName)
  // A write carrying none of the turn (rule 6f: approval_withdraw with no reason) is not judged.
  // Nor is a call to an MCP server on a turn whose every taint came from that same server (rule
  // 6g, returnsToOwnMcpServer): its arguments go back to where the data came from.
  // An edit of a pending approval's payload (rule 8g) is not judged here either: the edited
  // payload stays pending under the same approval, and the handler narrows that approval to
  // holders of the union taint (or refuses when nobody may then decide it).
  // A fetch of exactly one of this turn's own search results carries none of the turn: the search
  // service produced the URL, the model did not compose it (`searchResultUrlParam`), so the web-read
  // guardrails skip its shape and payload checks (its rate still counts). Only while the turn has
  // read nothing new since that search, once per URL, at most three per search
  // (turn-scope-accumulator.ts, claimSearchResultFetch). Read from the LIVE frame only, never
  // across a hop that lost it, and never for a call that also judges another thread (a desktop
  // gateway turn's connection thread), whose reads this turn's searches say nothing about.
  const turnSearchResults =
    opts.alsoJudgeTaintOnThreadId === undefined ? taintFrame?.turnScopeAccumulator : undefined
  let searchResultClaim: boolean | undefined
  const fetchesTurnSearchResult = (params: unknown): boolean => {
    if (searchResultClaim !== undefined) return searchResultClaim
    const param = tool.searchResultUrlParam
    searchResultClaim =
      typeof param === "string" &&
      turnSearchResults !== undefined &&
      params !== null &&
      typeof params === "object" &&
      turnSearchResults.claimSearchResultFetch((params as Record<string, unknown>)[param])
    return searchResultClaim
  }
  // A WEB READ NEVER PARKS (2026-10-29 owner ruling, scope-taint.ts rule 9). web_search and
  // web_fetch (`outboundWebRead`) are reads: on every surface, whatever the turn read, they are
  // neither judged as a scope-tainted write nor held by the outside-content rule. What they can
  // carry out is bounded by the guardrails below (web-read-guardrails.ts), refused inline. Writes
  // are untouched: the flag lives on the two web read tools alone.
  const isWebRead = tool.outboundWebRead === true
  // The live turn's accumulator: the frame's own, never across a hop that lost it (a call whose
  // turn's reads came forwarded) or for a call that also judges another thread.
  const liveTurnReads =
    opts.turnTaintScopes === undefined && opts.alsoJudgeTaintOnThreadId === undefined
      ? taintFrame?.turnScopeAccumulator
      : undefined
  if (
    turnTaintScopes !== undefined &&
    !isReadOnlyTool(tool) &&
    !isWebRead &&
    !approvalExecutingNestedCall &&
    !carriesNoTurnContent(tool, opts.params) &&
    !returnsToOwnMcpServer(opts.toolName, turnTaintScopes) &&
    tool.taintEditsPendingApproval !== true
  ) {
    const knownTaint =
      Array.isArray(turnTaintScopes) && turnTaintScopes.every((s) => typeof s === "string")
        ? turnTaintScopes
        : [...UNKNOWN_TURN_TAINT]
    if (knownTaint.length > 0) judgedTurnTaint = [...new Set(knownTaint)].sort()
    try {
      assertNoScopeTaintedWrite(tool.writesToTable ?? UNDECLARED_WRITE_TARGET, turnTaintScopes, {
        rowIds: targetRowIds(tool, opts.params),
        originRows: turnTaintOriginRows,
      })
    } catch (err) {
      if (!isScopeTaintBlockedWriteError(err)) throw err
      let audience: ScopeTaintAudience = "sink"
      // Who lacks what, counted for the refusal (scope-taint.ts, rule 7). Undefined for the
      // plain "sink" refusal, whose readers cannot be derived at all.
      let gap: TaintAudienceGap | undefined
      // A write to a table whose readers are declared or derived (scope-taint.ts, rule 6a) runs
      // when every one of those readers holds what the turn read. Only that table itself: the
      // refusal's target is compared, so nothing else inherits the allowance.
      let allowedBySinkReaders = false
      // The no-decider refusal (rule 8d) of a sequenced step whose head could not be widened.
      let noDeciderRefusal: string | undefined
      if (
        tool.gated !== true &&
        typeof tool.sinkReadScope === "string" &&
        err.writeTargetTable === tool.writesToTable
      ) {
        const readersGap = await readersTaintGap({
          orgId: opts.orgId,
          readerScopes: sinkReaderScopes(tool.sinkReadScope),
          taintScopes: knownTaint,
        })
        allowedBySinkReaders = readersGap === null
        if (readersGap) {
          audience = "readers"
          gap = readersGap
        }
      }
      // A write read by the acting user alone (rule 6d, notify_user) runs when that user's own
      // grants hold what the turn read.
      if (
        tool.gated !== true &&
        tool.sinkReadersSelf === true &&
        err.writeTargetTable === tool.writesToTable
      ) {
        const selfGap =
          opts.actor.actorType === "user"
            ? await selfReaderTaintGap({
                orgId: opts.orgId,
                userId: opts.actor.userId,
                taintScopes: knownTaint,
              })
            : { missingScopes: [], lacking: null }
        allowedBySinkReaders = selfGap === null
        if (selfGap) {
          audience = "requester"
          gap = selfGap
        }
      }
      // A write read only by the requester and the conversation's participants (rule 6e,
      // request_secret) runs when they all hold what the turn read: exactly the people its RLS
      // policy shows the row to.
      if (
        tool.gated !== true &&
        tool.sinkReadersConversation === true &&
        err.writeTargetTable === tool.writesToTable &&
        opts.actor.actorType === "user" &&
        typeof opts.threadId === "string"
      ) {
        const readersGap = await conversationReadersTaintGap({
          orgId: opts.orgId,
          threadId: opts.threadId,
          requesterUserId: opts.actor.userId,
          taintScopes: knownTaint,
        })
        allowedBySinkReaders = readersGap === null
        if (readersGap) {
          audience = "member"
          gap = readersGap
        }
      }
      // A sequenced @ref step is decided by its bundle head's approval (scope-taint.ts, rule
      // 8f). It parks only when every head it cites is this requester's pending request already
      // narrowed to holders of everything this turn read (`sequencedStepWithinHeadAudience`),
      // and the requester and the conversation's members hold it too (rule 6c): the head's
      // audience then bounds the step's. Otherwise it keeps the refusal ("unbounded").
      const judgeSequencedStep = async (): Promise<{
        park: boolean
        audience: ScopeTaintAudience
        gap?: TaintAudienceGap
        /** The whole refusal, when widening a head found nobody who could decide it. */
        message?: string
      }> => {
        const requesterUserId = opts.actor.actorType === "user" ? opts.actor.userId : ""
        const withinHead =
          requesterUserId !== "" &&
          (await sequencedStepWithinHeadAudience({
            orgId: opts.orgId,
            requesterUserId,
            approvalIds: findRefTokens(opts.params).map((r) => r.approvalId),
            taintScopes: knownTaint,
          }))
        if (!withinHead) {
          // The turn read more than its heads demand: widen this requester's own pending heads
          // to the union, as a restage of them would (rule 10a, 2026-11-03). Only a head that is
          // not the requester's pending request, or one nobody could then decide, refuses.
          const widened = await widenSequencedStepHeads({
            orgId: opts.orgId,
            requesterUserId,
            approvalIds: findRefTokens(opts.params).map((r) => r.approvalId),
            taintScopes: knownTaint,
          })
          if (!widened.ok) {
            return "message" in widened
              ? { park: false, audience: "unbounded", message: widened.message }
              : { park: false, audience: "unbounded" }
          }
        }
        const roomGap = await taintApprovalAudienceGapDetail({
          orgId: opts.orgId,
          threadId: opts.threadId,
          requesterUserId,
          requesterScopes: opts.actor.scopes ?? [],
          taintScopes: knownTaint,
        })
        return roomGap === null
          ? { park: true, audience }
          : { park: false, audience: roomGap.audience, gap: roomGap }
      }
      if (tool.gated === true) {
        // A sequenced @ref step is judged by its bundle head's audience (rule 8f,
        // `judgeSequencedStep`). Every other gated write PARKS (rule 8, 2026-10-20): the
        // approval is the disclosure decision. A shared ticket/mail draft (rule 6b) whose readers
        // lack the taint is no longer refused: the gap is carried to the card, which says so, and
        // to the row (`taintAudienceMustHold`), so only holders of the taint see the pending body
        // or decide it. The requester and the members of the conversation its card surfaces in
        // are still judged (rule 6c): the card shows the draft to them before anyone decides.
        const draftReadScope = sharedSurfaceDraftReadScope(opts.toolName)
        if (findRefTokens(opts.params).length > 0) {
          const judged = await judgeSequencedStep()
          if (judged.park) taintForcedApprovalScopes = [...new Set(knownTaint)].sort()
          else {
            audience = judged.audience
            gap = judged.gap
            noDeciderRefusal = judged.message
          }
        } else {
          let draftGap: TaintAudienceGap | null = null
          if (draftReadScope !== null) {
            const appName = opts.toolName.split(":")[0] ?? ""
            draftGap = await readersTaintGap({
              orgId: opts.orgId,
              readerScopes: [draftReadScope, decidingScopeForToolDef(tool, appName)],
              taintScopes: knownTaint,
            })
          }
          const roomGap = await taintApprovalAudienceGapDetail({
            orgId: opts.orgId,
            threadId: opts.threadId,
            requesterUserId: opts.actor.actorType === "user" ? opts.actor.userId : "",
            requesterScopes:
              opts.actor.actorType === "user" ? opts.actor.scopes : (opts.actor.scopes ?? []),
            taintScopes: knownTaint,
          })
          if (roomGap === null) {
            taintForcedApprovalScopes = [...new Set(knownTaint)].sort()
            if (draftGap) taintDisclosedToReaders = true
          } else {
            audience = roomGap.audience
            gap = roomGap
          }
        }
      }
      // AN UNGATED WRITE THE TAINT REFUSES PARKS FOR APPROVAL INSTEAD (rule 8, 2026-10-20): its
      // readers lack the taint (rules 6a, 6d) or cannot be derived (an undeclared target, a
      // table outside the app's schema). The approval makes the disclosure a decision by a person
      // who holds the taint, exactly as for a gated write, and the approved re-entry runs the
      // tool's own handler under the proposing turn's scopes. Judged like a gated write's card
      // first (rule 6c): the requester and the conversation's members see the card. A sequenced
      // @ref step is judged by its bundle head's audience (rule 8f, `judgeSequencedStep`).
      if (
        taintForcedApprovalScopes === null &&
        !allowedBySinkReaders &&
        tool.gated !== true &&
        findRefTokens(opts.params).length > 0
      ) {
        const judged = await judgeSequencedStep()
        if (judged.park) taintForcedApprovalScopes = [...new Set(knownTaint)].sort()
        else {
          audience = judged.audience
          gap = judged.gap
          noDeciderRefusal = judged.message
        }
      } else if (
        taintForcedApprovalScopes === null &&
        !allowedBySinkReaders &&
        tool.gated !== true
      ) {
        const roomGap = await taintApprovalAudienceGapDetail({
          orgId: opts.orgId,
          threadId: opts.threadId,
          requesterUserId: opts.actor.actorType === "user" ? opts.actor.userId : "",
          requesterScopes:
            opts.actor.actorType === "user" ? opts.actor.scopes : (opts.actor.scopes ?? []),
          taintScopes: knownTaint,
        })
        if (roomGap === null) {
          taintForcedApprovalScopes = [...new Set(knownTaint)].sort()
          taintDisclosedToReaders = true
        } else {
          audience = roomGap.audience
          gap = roomGap
        }
      }
      if (taintForcedApprovalScopes === null && !allowedBySinkReaders) {
        log.warn(
          { toolName: opts.toolName, writeTargetTable: err.writeTargetTable, audience },
          "Tool dispatch refused by scope taint",
        )
        // The requester's withheld card reads this to know a rerun would be refused the same way.
        if (taintFrame) taintFrame.scopeTaintRefused = true
        return {
          // Marked as the platform's own refusal: the MCP gateway records no taint for a
          // call refused here, and a handler returning the same code cannot pass for it.
          error: markPlatformTaintRefusal({
            code: err.code,
            message: `tool ${opts.toolName}: ${noDeciderRefusal ?? SCOPE_TAINT_BLOCKED_MESSAGE(err.writeTargetTable, knownTaint, audience, audience === "readers" ? (sharedSurfaceDraftReadScope(opts.toolName) ?? tool.sinkReadScope) : tool.sinkReadScope, gap)}${contentParamsRetryHint(tool)}`,
            retryable: false,
            // A refusal, not a fault: the seams log a 4xx at warn, and the agent is told why.
            status: 403,
          }),
        }
      }
    }
    // AN AGENT POST SOME READER COULD NOT SEE PARKS FOR THE REQUESTER (scope-taint.ts, rule 11,
    // 2026-11-03). A post into kernel.messages passes the sink check above (the message is
    // filtered per reader), so a participant lacking what the turn read used to get nothing,
    // silently. The post now waits for the requester, who holds the taint (rule 6c, judged here
    // too), and whose approval discloses it to the thread's people (the approved re-entry posts
    // it with them on its disclosure list). A post everyone can read runs inline as before. The
    // audience is the OTHER people: the requester's own grants are judged by the card's room check
    // (a requester lacking the taint cannot decide it, so the post is refused), and a post only the
    // requester could not read discloses nothing to anyone.
    const postAudience =
      opts.origin !== "human-ui" && taintForcedApprovalScopes === null && knownTaint.length > 0
        ? (tool.taintPostAudience?.(opts.params) ?? null)
        : null
    if (postAudience !== null) {
      const requesterUserId = opts.actor.actorType === "user" ? opts.actor.userId : ""
      const postGap =
        "threadId" in postAudience
          ? await conversationReadersTaintGap({
              orgId: opts.orgId,
              threadId: postAudience.threadId,
              requesterUserId,
              taintScopes: knownTaint,
              includeRequester: false,
            })
          : await peopleTaintGap({
              orgId: opts.orgId,
              userIds: postAudience.participantIds.filter((u) => u !== "" && u !== requesterUserId),
              taintScopes: knownTaint,
            })
      // An uncounted gap (an id that is no account of the org, an unknown taint, a failed lookup)
      // has nobody to disclose to: it is left to the handler's own checks, which refuse it.
      if (postGap !== null && postGap.lacking !== null) {
        const roomGap = await taintApprovalAudienceGapDetail({
          orgId: opts.orgId,
          threadId: opts.threadId,
          requesterUserId,
          requesterScopes: opts.actor.scopes ?? [],
          taintScopes: knownTaint,
        })
        if (roomGap !== null) {
          log.warn(
            { toolName: opts.toolName, audience: roomGap.audience },
            "Tool dispatch refused by scope taint: the post's approval would surface to people lacking the taint",
          )
          if (taintFrame) taintFrame.scopeTaintRefused = true
          return {
            error: markPlatformTaintRefusal({
              code: "E_SCOPE_TAINT_BLOCKED",
              message: `tool ${opts.toolName}: ${SCOPE_TAINT_BLOCKED_MESSAGE(SINK_KERNEL_MESSAGES, knownTaint, roomGap.audience, undefined, roomGap)}`,
              retryable: false,
              status: 403,
            }),
          }
        }
        taintForcedApprovalScopes = [...new Set(knownTaint)].sort()
        taintDisclosedToReaders = true
        taintPostHiddenFrom = postGap.lacking
        taintPostSnapshot =
          "threadId" in postAudience
            ? await threadPeopleIds(opts.orgId, postAudience.threadId)
            : [...new Set([requesterUserId, ...postAudience.participantIds])].filter(
                (u) => u !== "",
              )
      }
    }
  }

  // App↔app capability authorization. A cross-app (`internalCall`) dispatch
  // whose target the CALLER app declared in its `cross_app_calls` — and the
  // operator approved at install — is authorized by that capability grant. This
  // is the single authoritative gate for app↔app calls: it does NOT depend on
  // the caller app-actor's RBAC scopes (which gate user/agent access, not
  // app↔app capabilities). Event-driven handlers run as a bare `${app}:*`
  // system actor, so without this every automatic cross-app call is rejected.
  const callerApp = opts.internalCall?.callerApp
  const approvedCrossAppCall =
    callerApp != null &&
    (appCrossAppCallsRegistry.get([opts.orgId, callerApp])?.targets ?? []).includes(opts.toolName)
  // Only a DECLARED cross_app_calls target (approvedCrossAppCall) combined with
  // a human-authorized outer call skips the gate — an undeclared target stays
  // gated no matter how the outer call was authorized.
  const humanAuthorizedCrossAppCall =
    approvedCrossAppCall && opts.internalCall?.humanAuthorized === true
  // Provider-contract dispatch: the caller declares the contract, the bound provider implements
  // it, and this tool is that op's tool. A `contractOnly` tool accepts nothing else: not a user,
  // not an agent, not the API, not a plain `ctx.executeTool` from any app.
  const contractCall = opts.internalCall?.contractCall
  const approvedContractCall =
    contractCall != null &&
    callerApp != null &&
    isDeclaredContractDispatch(opts.orgId, callerApp, appName, name, contractCall)
  if (tool.contractOnly === true && !approvedContractCall) {
    return {
      error: {
        code: "forbidden",
        message: `tool ${opts.toolName} is a provider-contract op, reachable only through the contract dispatch`,
        retryable: false,
      },
    }
  }
  // An outbound contract op (a deposit, a transmission, a booking) runs only under the dispatch
  // grant a person's approval minted (provider-contracts/grant.ts), re-checked here against the
  // params actually dispatched so no path can widen it to another document or op.
  if (
    approvedContractCall &&
    contractCall &&
    isOutboundOp(contractCall.contract, contractCall.op)
  ) {
    const grantCheck = verifyContractGrant(contractCall.grant, {
      orgId: opts.orgId,
      callerApp: callerApp!,
      contract: contractCall.contract,
      op: contractCall.op,
      params: opts.params,
      provider: appName,
    })
    if (!grantCheck.ok) {
      return {
        error: {
          code: "forbidden",
          message: `tool ${opts.toolName}: ${grantCheck.message}`,
          retryable: false,
        },
      }
    }
  }

  // Cross-app callers may invoke an internal tool either via an approved
  // `cross_app_calls` capability, or (legacy) when they declared the dependency
  // and the target sets `deferLoading: true`.
  if (tool.trustBoundary === "internal") {
    const callerDeps =
      callerApp != null ? (appDependenciesRegistry.get([opts.orgId, callerApp])?.tools ?? []) : []
    const allowed =
      approvedCrossAppCall ||
      approvedContractCall ||
      (callerApp != null && callerDeps.includes(opts.toolName) && tool.deferLoading === true)
    if (!allowed) {
      return {
        error: {
          code: "forbidden",
          message: "Tool restricted to internal use",
          retryable: false,
        },
      }
    }
  }
  if (callerApp != null && ORIGINATING_APPROVAL_TOOLS.has(opts.toolName)) {
    const originating = await verifyOriginatingApproval({
      orgId: opts.orgId,
      callerApp,
      approvalId: (opts.params as Record<string, unknown> | null | undefined)
        ?.originating_approval_id,
      sendParams: opts.params,
    })
    if (!originating.ok) {
      return { error: { code: "forbidden", message: originating.message, retryable: false } }
    }
  }
  if (tool.trustBoundary === "agent" && !["agent", "system"].includes(opts.actor.actorType)) {
    return {
      error: {
        code: "forbidden",
        message: `tool ${opts.toolName} not callable by ${opts.actor.actorType}`,
        retryable: false,
      },
    }
  }
  if (
    tool.agentVisible === false &&
    (opts.actor as { actorType?: string }).actorType === "agent" &&
    !opts.internalCall
  ) {
    return {
      error: {
        code: "forbidden",
        message: `tool ${opts.toolName} not callable by agent`,
        retryable: false,
      },
    }
  }

  const actorScopes =
    opts.actor.actorType === "user" ? opts.actor.scopes : (opts.actor.scopes ?? [])
  // Cross-app dispatch (authorized by the `cross_app_calls` capability gate
  // above): the target tool is the TARGET app's code operating on the TARGET
  // app's data, so its RLS context must carry the target app's scopes —
  // mirroring event-driven handlers, which run as a `${app}:*` system actor.
  // Without this, the target app's own RLS-protected tables (e.g. shopify
  // `install_metadata`) are invisible under the *caller* app's scopes and reads
  // fail closed (the symptom: cross-app `shopify:variants_get` threw
  // "install_metadata row not found").
  //
  // The RLS scopes are the UNION of the target app's `*` AND the caller's own
  // scopes — NOT a replacement. A cross-app handler frequently has to read a
  // resource the CALLER hands it that lives under the CALLER's authority: e.g.
  // invoicing's gated send passes its rendered PDF (a `kernel.files` row whose
  // `files_select` RLS visibility is gated on its parent = an `app_invoicing`
  // document) to `mail:composeForApp`, which must read that file to attach it.
  // Replacing the caller's scopes with `mail:*` alone made the invoicing-parented
  // file invisible → "Source file not visible to caller" ([[BL-186]]). Unioning
  // can only ADD row-visibility (never remove it) and only widens the *RLS*
  // context — `actorScopes` / `ctx.scopes` (attribution + the handler's own
  // scope-subset checks) stay the caller's, so this is not a privilege grant.
  // A provider-contract op is the PROVIDER's code: it runs on the provider's own data only, never
  // with the caller's data scopes; the caller's files it needs (a legal original) reach it as an
  // explicit, per-call file grant the contract dispatch checked against the caller's own access.
  const actorForRls = approvedContractCall
    ? withAppDimensionAliases({ ...opts.actor, scopes: [`${appName}:*`] }, appName)
    : callerApp != null && callerApp !== appName
      ? withAppDimensionAliases(
          { ...opts.actor, scopes: [...new Set([`${appName}:*`, ...actorScopes])] },
          appName,
        )
      : withAppDimensionAliases(opts.actor, appName)
  // An install-approved cross-app capability authorizes the call regardless of
  // the caller app-actor's RBAC scopes (see `approvedCrossAppCall` above). The
  // RBAC scope check still gates user/agent callers and any undeclared call.
  const scopeCheck = checkToolScopes(tool, actorScopes)
  if (!approvedCrossAppCall && !approvedContractCall && !scopeCheck.authorized) {
    const missing =
      scopeCheck.required.length === 0
        ? `${appName}:${name} declares no scope`
        : scopeCheck.missing.join(", ")
    // D20: in a routine tick, say which scope the ROUTINE lacks and how to add it, so the
    // tick's reply in the routine's thread tells its owner what to do.
    const routineHint =
      currentRunContext()?.routineId && scopeCheck.missing.length > 0
        ? `. This routine does not hold ${scopeCheck.missing.join(", ")}: add it to the routine ` +
          `(Edit > Scopes in the routine, or ask the agent to add it with kernel__update_routine), ` +
          `then run it again.`
        : ""
    return {
      error: markRefusedBeforeRun(
        {
          code: "forbidden",
          message: `missing scope: ${missing}${routineHint}`,
          retryable: false,
        },
        opts.toolName,
      ),
    }
  }

  // A near-miss reference (`{{step1.record_id}}`, `@ref:<approval1>:id`, `$ref`, a token
  // without its uuid) is refused here with the exact form expected: passed through, the
  // literal placeholder would be stored or sent to a customer as is.
  // Checked on an agent's gated app calls only (the steps a sequence is built from): a
  // kernel tool may legitimately carry such text (a routine prompt that explains the form),
  // and a person's own call is never second-guessed for what it writes.
  const malformedRefs =
    (opts.origin === "in-app-agent" || opts.origin === "mcp") &&
    appName !== "kernel" &&
    (tool.gated || tool.conditionalGate)
      ? findMalformedRefs(opts.params)
      : []
  if (malformedRefs.length > 0) {
    return {
      error: markRefusedBeforeRun(
        {
          code: "invalid_ref",
          message: `invalid_ref: ${malformedRefMessage(opts.toolName, malformedRefs)}`,
          retryable: true,
        },
        opts.toolName,
      ),
    }
  }

  let validatedParams: unknown
  /** What the caller itself sent, before the schema's defaults were filled (A47b). */
  let rawParamsSent: unknown
  /** The paths the schema supplied, marked on the approval card so a reviewer sees them. */
  let defaultedParams: string[] = []
  try {
    validatedParams = validateParamsForTool(tool, opts.orgId, appName, name, opts.params)
    // A47b. The defaults are filled HERE, on a clone, before anything judges or shows the
    // call: the approval policy must decide on the arguments the handler will actually run
    // on (a default the policy would refuse if the agent had typed it must be refused when
    // the schema supplies it), and the reviewer must see them for the same reason. Which
    // paths came from the schema travels with the payload, so the card can mark them and
    // the agent's own arguments stay readable off the row.
    rawParamsSent = validatedParams
    if (isManifestHandler(tool.handler)) {
      validatedParams = withManifestDefaults(tool, validatedParams)
      defaultedParams = defaultedParamPaths(rawParamsSent, validatedParams)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid parameters"
    // A parameter-format error is the retryable class — the caller (or the
    // model) can correct the arguments from the detailed message and try again.
    return {
      error: markRefusedBeforeRun(
        { code: "invalid_params", message, retryable: true },
        opts.toolName,
      ),
    }
  }

  // Bulk agent tools: dispatch through runBulkDispatch using the full actor context.
  const bulkMeta = (tool as { bulkMeta?: BulkToolMeta }).bulkMeta
  if (bulkMeta) {
    const { runBulkDispatch, BulkDispatchError } = await import("~/modules/apps/bulk-dispatch")
    const p = validatedParams as Record<string, unknown>
    const ids = (p.ids ?? []) as string[]
    const idempotencyKey = String(p.idempotencyKey)
    let action: string
    let bulkParams: Record<string, unknown>
    if (bulkMeta.operationMap) {
      const operation = String(p.operation)
      const mapped = bulkMeta.operationMap[operation]
      if (!mapped) {
        return {
          error: {
            code: "invalid_params",
            message: `Unknown bulk operation "${operation}"`,
            retryable: false,
          },
        }
      }
      action = mapped
      bulkParams = (p.params ?? {}) as Record<string, unknown>
    } else {
      action = bulkMeta.action!
      const { ids: _ids, idempotencyKey: _idem, ...rest } = p
      bulkParams = rest
    }
    try {
      const result = await runBulkDispatch({
        app: bulkMeta.app,
        action,
        ids,
        params: bulkParams,
        idempotencyKey,
        actor: opts.actor,
        // Propagate provenance so each per-item re-entrant call still looks
        // like the agent/MCP call it actually is, not a direct human click
        // that would silently skip the approval gate.
        origin: opts.origin,
      })
      return { data: result }
    } catch (err) {
      if (err instanceof BulkDispatchError) {
        return { error: { code: err.code, message: err.message, retryable: false } }
      }
      throw err
    }
  }

  const idemKey =
    opts.internalCall?.idempotencyKey ??
    (typeof (validatedParams as any)?.idempotencyKey === "string"
      ? ((validatedParams as any).idempotencyKey as string)
      : undefined)
  const innerChain = [...callChain, opts.toolName]
  const userId = opts.actor.actorType === "user" ? opts.actor.userId : "system"

  // Stage-time preflights validate the CONCRETE params (a draft resolves, an
  // offer was quoted, no duplicate row). A sequenced bundle step's params carry
  // literal `@ref:` tokens that only resolve at cascade time — running the
  // preflight against a token (e.g. boxtal create_shipment deriving a draft
  // from draft_id="@ref:…") fails on the placeholder, not on anything real, and
  // wrongly blocks staging the chain. Skip the preflight for token-bearing
  // calls; execution-time validation still runs post-resolution, and a failing
  // step cancels the bundle remainder + re-invokes the agent (cascade-fail).
  //
  // CONDITIONALLY-gated tools are preflighted too. A `conditionalGate` tool is
  // not `gated`, but its handler parks an approval for some params (an
  // org-scoped knowledge doc, an invoice over the issuer threshold) — and a
  // gated call must never be queued for a human when the data it needs is
  // missing. Requiring `tool.gated` here left every such tool validating only
  // AFTER the approver clicked approve.
  // A host tool's outright refusal of its caller comes before every gate below: a caller that may
  // never run the tool must not leave an approval behind for a human to decide in vain.
  if (tool.refuseBeforeGate && !approvalExecutingNestedCall && opts.origin !== "human-ui") {
    const refusal = await tool.refuseBeforeGate(validatedParams, {
      orgId: opts.orgId,
      userId,
      scopes: actorScopes,
    })
    if (refusal) {
      // A refusal shaped as a tool error with its status is answered as that error,
      // exactly as the handler's own would be; any other answer is the tool's result.
      const refusalError = normalizeToolErrorResult(refusal)
      if (refusalError?.status !== undefined) return { error: refusalError }
      return { data: refusal }
    }
  }

  // WEB-READ GUARDRAILS (web-read-guardrails.ts). A web read runs without an approval (rule 9),
  // so what it can carry out is bounded here, for every surface, refused inline with the limit it
  // hit. Payload checks apply when the turn read org data, or when its reads are unknown (a hop
  // that lost the live frame): fail closed. Any other tool call ends a run of web reads.
  if (opts.origin !== "human-ui" && !approvalExecutingNestedCall) {
    const turnWebReads = liveTurnReads?.webReads()
    if (!isWebRead) {
      if (turnWebReads) noteNonWebToolCall(turnWebReads)
    } else {
      const orgDataRead = liveTurnReads ? liveTurnReads.readInternalData() : true
      const params = (validatedParams ?? {}) as Record<string, unknown>
      let fetchHost: string | undefined
      let refusal: ExecuteToolError | null = null
      if (tool.searchResultUrlParam !== undefined) {
        const url = params[tool.searchResultUrlParam]
        try {
          fetchHost = typeof url === "string" ? new URL(url).hostname : undefined
        } catch {
          fetchHost = undefined
        }
        if (!fetchesTurnSearchResult(validatedParams)) {
          refusal = webFetchUrlRefusal(url, { orgDataRead })
        }
      } else {
        refusal = webSearchQueryRefusal(params.query, { orgDataRead })
      }
      if (!refusal && turnWebReads) refusal = takeTurnWebRead(turnWebReads, { host: fetchHost })
      if (!refusal) {
        refusal = await takeThreadWebRead({
          orgId: opts.orgId,
          threadId: opts.threadId,
          actorKey: opts.actor.actorType === "user" ? opts.actor.userId : opts.actor.actorType,
        })
      }
      if (refusal) {
        log.warn(
          { toolName: opts.toolName, orgId: opts.orgId, threadId: opts.threadId, orgDataRead },
          `web read refused by guardrail: ${refusal.message}`,
        )
        return { error: refusal }
      }
    }
  }

  // A company's legal identifiers (SIREN, VAT, IBAN...) come from the person,
  // never from the model: an agent's call (in-app or an MCP client) that sets
  // one the person never gave in this conversation is refused before any gate.
  // Which tools and params hold them is the host's own list, not the manifest's.
  if ((opts.origin === "in-app-agent" || opts.origin === "mcp") && !approvalExecutingNestedCall) {
    const refusal = await legalIdentityRefusal({
      orgId: opts.orgId,
      tool: `${tool.appName}:${tool.name}`,
      params: validatedParams,
      threadId: opts.threadId,
    })
    if (refusal) return { error: refusal.error }
    // The same for a mailbox or inbox address a config tool connects.
    const addressRefusal = await addressGroundingRefusal({
      orgId: opts.orgId,
      tool: `${tool.appName}:${tool.name}`,
      params: validatedParams,
      threadId: opts.threadId,
    })
    if (addressRefusal) return { error: addressRefusal.error }
  }

  // An outbound message (an email, a ticket reply, a DM) never carries an unfilled template slot
  // such as "[DATE]", "{{name}}" or "TBD": the call is refused before any gate, so no approver is
  // shown it and no customer receives it. A person's own text from the UI is theirs to send.
  if (tool.outboundTextParams && !approvalExecutingNestedCall && opts.origin !== "human-ui") {
    const refusal = await outboundPlaceholderRefusal({
      orgId: opts.orgId,
      userId: opts.actor.actorType === "user" ? opts.actor.userId : null,
      params: validatedParams,
      outboundTextParams: tool.outboundTextParams,
    })
    if (refusal) {
      return {
        error: {
          code: "invalid_params",
          message: `tool ${opts.toolName}: ${refusal}`,
          retryable: true,
        },
      }
    }
  }

  // A param the tool declares PINNED is the server's to set (its preflight pins it, the card shows
  // it, the execution checks it): a caller's own value is never trusted, so it is dropped before
  // anything reads the call. A pinned value only ever comes from this call's preflight.
  const pinnedKeys = tool.pinnedParams ?? []
  if (
    pinnedKeys.length > 0 &&
    typeof validatedParams === "object" &&
    validatedParams !== null &&
    !Array.isArray(validatedParams)
  ) {
    const unpinned: Record<string, unknown> = { ...(validatedParams as Record<string, unknown>) }
    for (const key of pinnedKeys) delete unpinned[key]
    validatedParams = unpinned
  }
  const paramsCarryRefTokens = findRefTokens(validatedParams).length > 0
  // A token-bearing call skips the preflight (below), so a tool whose approval binds pinned
  // values would be staged with none: refused at stage time instead. Nothing is staged.
  if ((tool.gated || tool.conditionalGate) && pinnedKeys.length > 0 && paramsCarryRefTokens) {
    return {
      error: {
        code: "ref_not_allowed",
        message:
          `${opts.toolName} can't take an @ref reference to an earlier step: its approval binds ` +
          "values that must exist when it is proposed. Do not chain it: wait until the earlier step " +
          "has been approved and has run, then call it with that step's real result values.",
        retryable: false,
      },
    }
  }
  // Set when the preflight says THIS call must be decided by a person (preflightRequiresPerson).
  let preflightForcesPerson = false
  if ((tool.gated || tool.conditionalGate) && tool.preflight && !paramsCarryRefTokens) {
    const preflightResult = await withRlsContext(actorForRls, (tx) =>
      executeToolHandler(
        tool,
        tool.preflight!,
        userId,
        opts.orgId,
        actorScopes,
        tx,
        validatedParams,
        undefined,
        {
          callChain: innerChain,
          parentExecutionToken: opts.parentExecutionToken,
          taintState: opts.taintState,
          actor: actorForRls,
          threadId: opts.threadId,
          origin: opts.origin, // propagate MCP/in-app-agent attribution (preflight site)
          callerApp, // declared cross-app origin (undefined for direct calls)
          priority: opts.priority, // propagate worker-pool scheduling class (preflight site)
          nested: isNestedDispatch, // reentrancy admission (preflight site)
          signal: opts.signal,
          actingAgentId, // FX3-1: the agent this dispatch acts as (preflight site)
        },
      ),
    )
    const preflightError = normalizeToolErrorResult(preflightResult)
    if (preflightError) return { error: preflightError }
    preflightForcesPerson = preflightRequiresPerson(preflightResult)
    // Everything below (idempotency, dedupe, summary links, the stored payload)
    // keys on the canonical id the preflight resolved, not the caller's alias.
    validatedParams = applyPreflightCanonicalParams(validatedParams, preflightResult)
  }

  if (idemKey) {
    const reservation = await reserveIdempotency(
      opts.orgId,
      opts.toolName,
      idemKey,
      validatedParams,
    )
    if (reservation.outcome === "hit") return reservation.cached as ExecuteToolEnvelope
    if (reservation.outcome === "conflict") {
      return {
        error: {
          code: "idempotency_conflict",
          message: "different params for same idempotency key",
          retryable: false,
        },
      }
    }
    if (reservation.outcome === "in_flight") {
      return {
        error: {
          code: "idempotency_in_flight",
          message: "concurrent call with same idempotency key in progress",
          retryable: true,
        },
      }
    }
  }

  // TAINT ESCALATION. A turn that read untrusted outside text must not run a tool with an
  // external side effect or an exfiltration channel on its own: the call parks as an approval a
  // human decides (never a hard failure). "hardened" extends that to every trust-boundary tool.
  // A gated tool is already parked by the gate below, so only the ungated ones are judged here.
  // `requiresHumanTurn` (code on the owner's machine) also parks when the call does not come from a
  // turn the person typed (routine, trigger, inbound event, sub-run, agent ask, MCP).
  // A web read (web_fetch) is never held (rule 9): the guardrails above bound it instead.
  // A read on an MCP server whose outside text alone marked the thread (rule 6h): the injected
  // text can at most make the agent read more of that same server.
  const ownServerRead = mcpReadOfOwnServer(opts.toolName, tool.mcpAnnotations)
  const taintExternalEffect =
    tool.externalEffect === true &&
    tool.gated !== true &&
    !isWebRead &&
    !(
      opts.threadId &&
      !approvalExecutingNestedCall &&
      opts.origin !== "human-ui" &&
      ownServerRead !== null &&
      (await outsideTextOnlyFrom(
        [opts.threadId, opts.alsoJudgeTaintOnThreadId].filter(
          (t, i, all): t is string => typeof t === "string" && all.indexOf(t) === i,
        ),
        opts.orgId,
        ownServerRead,
      ))
    )
  const taintNeedsHumanTurn =
    typeof tool.requiresHumanTurn === "function"
      ? tool.requiresHumanTurn(validatedParams)
      : tool.requiresHumanTurn === true
  // Without a thread there is no turn to judge and no place to park an approval: code on the
  // person's machine is then refused outright rather than run unchecked.
  if (
    taintNeedsHumanTurn &&
    !opts.threadId &&
    !approvalExecutingNestedCall &&
    opts.origin !== "human-ui"
  ) {
    return {
      error: {
        code: "forbidden",
        message: `${opts.toolName} runs only from a conversation turn a person typed`,
        retryable: false,
      },
    }
  }
  let taintEscalated = false
  // The threads this call's untrusted-content mark is read from: its own, and a desktop gateway
  // turn's connection thread as well (`alsoJudgeTaintOnThreadId`, S59).
  const taintThreads = [opts.threadId, opts.alsoJudgeTaintOnThreadId].filter(
    (t, i, all): t is string => typeof t === "string" && all.indexOf(t) === i,
  )
  const untrustedOnTurnThreads = async (): Promise<boolean> => {
    for (const threadId of taintThreads) {
      if (await untrustedTurnNeedsApproval(threadId, opts.orgId)) return true
    }
    return false
  }
  if (
    opts.threadId &&
    !approvalExecutingNestedCall &&
    opts.origin !== "human-ui" &&
    (tool.trustBoundary || taintExternalEffect || taintNeedsHumanTurn)
  ) {
    if (taintNeedsHumanTurn && !isHumanTypedTurn(currentRunContext())) taintEscalated = true
    if (!taintEscalated && taintNeedsHumanTurn) {
      taintEscalated = await untrustedOnTurnThreads()
    }
    for (const threadId of taintThreads) {
      if (taintEscalated || !(tool.trustBoundary || taintExternalEffect)) break
      const taintResult = await checkTaintEscalation({
        threadId,
        orgId: opts.orgId,
        toolHasTrustBoundary: !!tool.trustBoundary,
        toolHasExternalEffect: taintExternalEffect,
      })
      taintEscalated = taintResult.blocked
    }
  }

  // Direct human UI calls (origin "human-ui", actorType "user") are a person's
  // own action: they run when the person holds the tool's deciding scope (the
  // click IS the decision) and are refused otherwise; they never park an
  // approval and no auto-approve policy answers them (computeSkipGate). The audit row is still emitted by the handler under
  // actorType:"user" so traceability is preserved. Agent and MCP calls
  // keep the standard approval flow. origin is REQUIRED on every call into
  // the core, so a caller that forgets to set it fails to compile instead
  // of silently reading as a human click (this is the fix for the discriminator
  // that used absence of origin as proof of a human UI click).
  const isDirectHumanCall = opts.origin === "human-ui" && opts.actor.actorType === "user"
  // Host rules that make an agent call a gated one (scopes/host-approval-gates.ts): a write to
  // memory after the turn read outside text, a calendar event inviting an address
  // nobody in the organisation has dealt with. The normal approval flow follows, which an
  // auto-approve policy may answer. Never for a person's own click.
  const hostGated =
    tool.gated !== true &&
    !approvalExecutingNestedCall &&
    opts.origin !== "human-ui" &&
    ((await hostRequiresApproval({
      toolName: opts.toolName,
      params: validatedParams,
      orgId: opts.orgId,
      threadId: opts.threadId,
      ...(tool.writesToTable ? { writesToTable: tool.writesToTable } : {}),
    })) ||
      (opts.alsoJudgeTaintOnThreadId !== undefined &&
        (await hostRequiresApproval({
          toolName: opts.toolName,
          params: validatedParams,
          orgId: opts.orgId,
          threadId: opts.alsoJudgeTaintOnThreadId,
          ...(tool.writesToTable ? { writesToTable: tool.writesToTable } : {}),
        }))))
  // A tool gated for some params only (`gatedWhen`): decided here, before the call runs.
  const paramGated =
    tool.gated !== true &&
    !approvalExecutingNestedCall &&
    tool.gatedWhen !== undefined &&
    (await tool.gatedWhen(validatedParams, { orgId: opts.orgId }).catch((err: unknown) => {
      log.error({ err, toolName: opts.toolName }, "gatedWhen failed: the call is gated")
      return true
    }))

  // A DISCLOSURE DECISION, NOTHING MORE (scope-taint.ts, rule 8h, 2026-10-27). An ungated write
  // parked ONLY because the turn read scoped data (rule 8b) would have run inline on a clean turn:
  // the one question its approval answers is whether what the turn read may reach the write's
  // readers. It is decided by holding every scope the turn read, never by `<app>:approve`, which
  // for kernel tools is the admin-grade scope of role edits (a support analyst's memory note
  // parked for every admin, and she could not decide her own card). Anything else that gates the
  // call keeps the tool's own deciding scope: a gated tool, a host or per-param gate, the
  // outside-content hold, an org approval policy, a sequenced @ref step, a routine's request.
  const taintDisclosureOnly =
    taintForcedApprovalScopes !== null &&
    tool.gated !== true &&
    !hostGated &&
    !paramGated &&
    !taintEscalated &&
    findRefTokens(validatedParams).length === 0 &&
    !currentRunContext()?.routineId &&
    !(await evaluateApprovalPolicy({
      orgId: opts.orgId,
      toolName: opts.toolName,
      appName,
      params: validatedParams,
    })
      .then((p) => p.requireApproval || p.minApprovers >= 2)
      .catch((err: unknown) => {
        log.error(
          { err, toolName: opts.toolName },
          "approval-policy evaluation failed: the tainted call keeps the tool's deciding scope",
        )
        return true
      }))
  const disclosureAuthority =
    taintDisclosureOnly && taintForcedApprovalScopes !== null
      ? taintDisclosureAuthority(taintForcedApprovalScopes)
      : null

  // Dimension-constrained approvals: a gated tool may declare a CUSTOM decision
  // scope (`approveScope`) and resolve an optional dimension constraint at PROPOSE
  // time. Resolution is the shared authority answer (`resolveToolApprovalAuthority`
  // — same resolver as the handler-conditional gate path, fail-closed sentinel
  // included). The requester can self-approve only when they hold the (custom)
  // approve scope AND either bypass the constraint (super-admin) or their own
  // dimension grants cover it.
  // A disclosure decision (above) takes its authority from the turn's taint instead.
  const { approveScope, dimensionConstraint } =
    disclosureAuthority ??
    (await resolveToolApprovalAuthority({
      orgId: opts.orgId,
      appName,
      toolShortName: name,
      params: validatedParams,
    }))
  const requesterCanApprove =
    hasScope(approveScope, actorScopes) &&
    (dimensionConstraint === null ||
      bypassesDimensionConstraint(actorScopes) ||
      dimensionGrantCovers(
        (await loadActorDimensionGrants(opts.orgId, userId)) ?? {},
        dimensionConstraint.key,
        dimensionConstraint.values,
      ))

  let envelope: ExecuteToolEnvelope

  // Rule 8: a tainted proposal some readers of its target cannot see says so on its card, in
  // plain words, because approving it is the disclosure. Kept inside the 8-line cap.
  const withTaintDisclosure = (s: ApprovalSummary): ApprovalSummary =>
    taintDisclosedToReaders
      ? {
          ...s,
          lines: [
            ...s.lines.slice(0, 7),
            taintPostHiddenFrom !== undefined
              ? taintPostDisclosureLine(taintForcedApprovalScopes ?? [], taintPostHiddenFrom)
              : taintDisclosureLine(
                  taintForcedApprovalScopes ?? [],
                  taintSurfaceLabelForTool(opts.orgId, opts.toolName, tool.writesToTable),
                ),
          ],
        }
      : s
  // A tainted proposal nobody may decide (no holder of the deciding scope also holds what the
  // turn read) is refused now, naming the remedy: parking it would wait for a decider who
  // cannot exist (rule 8). Checked before either parking path (taint escalation, the gate)
  // creates a thread or a row.
  // Every approval this call parks is narrowed to holders of what its turn read (rule 13): the
  // taint-forced audience when the taint parked it, else the judged turn's whole taint.
  const parkTaint: string[] | null = taintForcedApprovalScopes ?? judgedTurnTaint
  const noTaintDeciderRefusal = async (mustHold: string[]): Promise<ExecuteToolEnvelope | null> => {
    const resourceOwnerId = await resolveApprovalOwnerRouting({
      orgId: opts.orgId,
      appName,
      toolShortName: name,
      toolParams: validatedParams,
      requestedBy: userId,
      approveScope,
      dimensionConstraint,
      mustHold,
      actingAgentId,
    })
    // The requester, who holds the taint (rule 6c, judged above), is a decider when they may
    // approve it: the same answer the card's "you can approve this" is built from.
    const hasDecider =
      (resourceOwnerId === null && requesterCanApprove && holdsEveryScope(actorScopes, mustHold)) ||
      (await taintedApprovalHasDecider({
        orgId: opts.orgId,
        toolApp: opts.toolName.split(":")[0] ?? "",
        resourceOwnerId,
        approveScope,
        dimensionConstraint,
        mustHold,
      }))
    if (hasDecider) return null
    if (idemKey) await invalidateIdempotency(opts.orgId, opts.toolName, idemKey)
    log.warn(
      { toolName: opts.toolName, approveScope },
      "Tool dispatch refused by scope taint: no approver holds the turn's scopes",
    )
    if (taintFrame) taintFrame.scopeTaintRefused = true
    return {
      error: markPlatformTaintRefusal({
        code: "E_SCOPE_TAINT_BLOCKED",
        message: `tool ${opts.toolName}: ${SCOPE_TAINT_NO_DECIDER_MESSAGE(mustHold, approveScope)}${contentParamsRetryHint(tool)}`,
        retryable: false,
        status: 403,
      }),
    }
  }
  if (taintForcedApprovalScopes !== null && findRefTokens(validatedParams).length === 0) {
    const refusal = await noTaintDeciderRefusal(taintForcedApprovalScopes)
    if (refusal) return refusal
  }
  // Set only inside the threaded branch above; `opts.threadId` narrows for the row below.
  if (taintEscalated && opts.threadId) {
    // A write the taint let through, held for its outside content: decided by a holder of the
    // turn's taint, or refused now when nobody may (rule 13). A taint-forced one was checked above.
    if (taintForcedApprovalScopes === null && parkTaint !== null) {
      const refusal = await noTaintDeciderRefusal(parkTaint)
      if (refusal) return refusal
    }
    const summary = withTaintDisclosure(
      await withRlsContext(actorForRls, (tx) =>
        generateApprovalSummary(
          opts.orgId,
          appName,
          name,
          validatedParams,
          {
            tx,
            orgId: opts.orgId,
            userId,
            actor: actorForRls,
            ...(opts.threadId ? { threadId: opts.threadId } : {}),
            actingAgentId: resolveActingAgentId(opts.actingAgentId),
          },
          opts.toolName,
        ),
      ),
    )
    const approvalRequestId = await createApprovalRequest({
      orgId: opts.orgId,
      threadId: opts.threadId,
      toolName: opts.toolName,
      toolParams: validatedParams,
      defaultedParams,
      requestedBy: userId,
      reason: "taint_escalation",
      summary,
      appName,
      toolShortName: name,
      requesterCanApprove,
      approveScope,
      dimensionConstraint,
      origin: opts.origin,
      proposingTurnScopes: opts.turnTaintScopes,
      ...(parkTaint
        ? {
            audienceMustHold: parkTaint,
            taintDisclosedToReaders,
            ...(taintPostSnapshot ? { taintDisclosureAudience: taintPostSnapshot } : {}),
          }
        : {}),
      actingAgentId,
    })
    envelope = {
      blocked: {
        reason: "taint_escalation",
        approvalRequestId,
        summary,
        requesterCanApprove,
        outsideText: OUTSIDE_TEXT_HOLD_NOTE,
        ...(await gatedAgentNotesFor(tool, validatedParams, {
          orgId: opts.orgId,
          userId,
          scopes: actorScopes,
        })),
      },
    }
    if (idemKey)
      await finalizeIdempotency(opts.orgId, opts.toolName, idemKey, validatedParams, envelope)
    return envelope
  }

  const {
    skip: skipGate,
    autoApprovedByPolicy,
    autoApprovedByCapability,
    capabilityHumanAuthorization,
    effectiveGated,
    mustSequence,
    minApprovers,
    tightenedByPolicy,
    tightenReason,
    personRefusal,
  } = await computeSkipGate({
    // A write the scope taint parks (rule 8) is gated for this call, whatever its declaration.
    gated: (tool.gated ?? false) || hostGated || paramGated || taintForcedApprovalScopes !== null,
    isDirectHumanCall,
    personHoldsToolScopes: scopeCheck.authorized,
    requesterCanApprove,
    orgId: opts.orgId,
    toolName: opts.toolName,
    appName,
    actor: opts.actor,
    validatedParams,
    evaluate: evaluateAutoApprove,
    machineAuthorizedCrossAppCall: approvedCrossAppCall,
    humanAuthorizedCrossAppCall,
    humanAuthorizedVia: opts.internalCall?.humanAuthorizedVia,
    outerApprovalRequestId: opts.internalCall?.outerApprovalRequestId,
    outerActorId: opts.actor.actorType === "user" ? opts.actor.userId : undefined,
    origin: opts.origin,
    callerApp,
    // The tool's own flag, or its preflight's verdict on this call's params.
    noAutoApprove: tool.noAutoApprove === true || preflightForcesPerson,
    // An auto-approve policy does not wave an outward action through for a turn that read
    // untrusted text (auto-approve.ts), unless the org switched that protection off.
    ...(opts.threadId ? { untrustedTurn: untrustedOnTurnThreads } : {}),
  })

  // `effectiveGated` is the TIGHTEN-ONLY composition of the built-in `tool.gated`
  // and the org's approval-tightening policy: a policy can escalate a non-gated
  // action into a gated one (BL-268). The N-eyes floor (`minApprovers`) + the
  // triggering policy line are persisted on the approval so the card shows
  // "requires a 2nd approver per org policy" and decide.ts enforces it.
  // A person's own call parks only under an N-eyes policy (computeSkipGate); their
  // click is their sign-off when they could decide it themselves, so the request
  // then needs only the remaining DISTINCT approvers (decide.ts never counts the
  // same person twice).
  const approvalTighten =
    minApprovers >= 2 || tightenedByPolicy
      ? {
          minApprovers,
          tightenedByPolicy,
          tightenReason,
          ...(isDirectHumanCall && requesterCanApprove && minApprovers >= 2
            ? { requesterSignedOff: true }
            : {}),
        }
      : undefined
  // A person's own call that their permissions do not cover is refused here:
  // it never parks an approval (approvals are for agents) and never runs.
  if (personRefusal) {
    if (idemKey) await invalidateIdempotency(opts.orgId, opts.toolName, idemKey)
    return {
      error: personRefusalError(personRefusal, opts.toolName, scopeCheck.missing),
    }
  }
  // Enter the approval/sequencing block when the tool is gated OR when the call
  // carries @ref tokens (`mustSequence`): a non-gated @ref step still needs to be
  // deferred into the bundle (refs.length > 0 routes it to the sequenced-step
  // branch below), never executed inline against an unresolved placeholder.
  // A tainted gated write that passed its audience check is ALWAYS parked: an auto-approve
  // policy or a capability grant must not turn it into an inline write from a tainted turn.
  if ((effectiveGated || mustSequence) && (!skipGate || taintForcedApprovalScopes !== null)) {
    let effectiveThreadId = opts.threadId
    let autoCreatedApprovalId: string | undefined
    if (!effectiveThreadId) {
      // A sequenced (@ref) step must resolve against a REAL prior thread —
      // resolveBundleForRefs/validateRefSources look up earlier approvals in
      // that specific conversation — so it still fails clean rather than
      // fabricate one.
      if (mustSequence) {
        envelope = {
          error: {
            code: "forbidden",
            message: "Tool is gated — threadId required to create an approval request",
            retryable: false,
          },
        }
        if (idemKey) await invalidateIdempotency(opts.orgId, opts.toolName, idemKey)
        return envelope
      }
    }
    // No conversation thread to attach the approval to (a threadless gated
    // call by an agent, MCP client or system caller, or a person's own call
    // under an N-eyes policy) must still park a reviewable approval
    // instead of erroring —
    // mirrors createHandlerApprovalRequest's own fallback of auto-creating a
    // dedicated surface thread for a threadless request.
    //
    // LAZY on purpose: creating the thread up here left an EMPTY thread with a
    // `createdFrom` pointing at an approval id that was never inserted whenever
    // the dedupe lookup below re-surfaced an existing pending approval (or
    // anything in between threw). It is created only from the arm that really
    // inserts a new approval request.
    const ensureApprovalThreadId = async (): Promise<string> => {
      if (effectiveThreadId) return effectiveThreadId
      autoCreatedApprovalId = crypto.randomUUID()
      const approvalIdForThread = autoCreatedApprovalId
      effectiveThreadId = await withPrivilegedDb(
        opts.orgId,
        "gated-tool-approval-thread",
        async (tx) => {
          const { thread } = await insertThreadWithParticipants(tx, {
            orgId: opts.orgId,
            userId,
            participantIds: [userId],
            title: `Approval: ${appName}:${name}`,
            isPinned: false,
            // Internal anchor only: never surfaced in anyone's sidebar.
            hiddenFromList: true,
            createdFrom: {
              app: "kernel",
              entityType: "approval_request",
              entityId: approvalIdForThread,
            },
            type: "approval",
          })
          return thread.id
        },
      )
      return effectiveThreadId
    }
    const baseSummary = await withRlsContext(actorForRls, (tx) =>
      generateApprovalSummary(
        opts.orgId,
        appName,
        name,
        validatedParams,
        {
          tx,
          orgId: opts.orgId,
          userId,
          actor: actorForRls,
          ...(opts.threadId ? { threadId: opts.threadId } : {}),
          actingAgentId: resolveActingAgentId(opts.actingAgentId),
        },
        opts.toolName,
      ),
    )
    // Surface the triggering tightening policy on the approval card so the human
    // reviewer sees WHY a 2nd approver is required (BL-268). Appended last,
    // truncated to the 8-line cap.
    const tightenedSummary =
      approvalTighten?.tightenReason && baseSummary.lines.length < 8
        ? {
            ...baseSummary,
            lines: [
              ...baseSummary.lines,
              minApprovers >= 2
                ? `Requires ${minApprovers} approvers per org policy: ${approvalTighten.tightenReason}`
                : `Requires approval per org policy: ${approvalTighten.tightenReason}`,
            ],
          }
        : baseSummary
    // Scan the validated params for @ref tokens. If present, this gated call is a
    // sequenced step depending on a prior approval — link it into a bundle.
    const refs = findRefTokens(validatedParams)
    // A sequenced step's summarizer saw the literal tokens (its params carry
    // `@ref:<uuid>:<key>` placeholders), so the card would show raw token noise
    // ("Stage return label for draft @ref:0b12…") to the human deciding the
    // bundle. Each token reads as the earlier step it comes from ("the quote
    // PDF from step 2") -- the human must be able to read all N stacked actions
    // without decoding UUIDs.
    const summary = withTaintDisclosure(
      refs.length > 0
        ? await humanizeStepSummary(opts.orgId, userId, validatedParams, tightenedSummary)
        : tightenedSummary,
    )
    // An N-eyes floor this request's audience can never meet (a personal
    // resource only its owner decides, or fewer deciders than required) is
    // refused now, for a person and an agent alike: parking it would wait for a
    // second approver who cannot exist. Checked before any thread is created.
    if (refs.length === 0 && minApprovers >= 2) {
      try {
        await assertApproversAvailable({
          orgId: opts.orgId,
          toolName: opts.toolName,
          minApprovers,
          resourceOwnerId: await resolveApprovalOwnerRouting({
            orgId: opts.orgId,
            appName,
            toolShortName: name,
            toolParams: validatedParams,
            requestedBy: userId,
            approveScope,
            dimensionConstraint,
            mustHold: parkTaint ?? [],
            actingAgentId,
          }),
          approveScope,
          dimensionConstraint,
          mustHold: parkTaint ?? [],
        })
      } catch (err) {
        if (!(err instanceof ApproversUnavailableError)) throw err
        if (idemKey) await invalidateIdempotency(opts.orgId, opts.toolName, idemKey)
        return {
          error: { code: err.code, message: err.message, retryable: false, status: err.status },
        }
      }
    }
    if (refs.length === 0) {
      // A write the taint let through, parking for its gate: decided by a holder of the turn's
      // taint, or refused now when nobody may (rule 13). A taint-forced one was checked above.
      if (taintForcedApprovalScopes === null && parkTaint !== null) {
        const refusal = await noTaintDeciderRefusal(parkTaint)
        if (refusal) return refusal
      }
      // Opt-in gated IDEMPOTENCY: if this tool declares a dedupe-key param and an
      // un-decided approval for the SAME (org, tool, key-value) already exists,
      // re-surface THAT pending approval instead of stacking a duplicate (one
      // pending approval per keyed action — e.g. boxtal:create_shipment per draft).
      // A bundled (@ref) step is excluded on purpose: its dedupe semantics belong to
      // the bundle, not this standalone path.
      const dedupeKeyParam = approvalDedupeKeyRegistry.get([opts.orgId, appName, name])
      let approvalRequestId: string | null = null
      const rawDedupeKey = dedupeKeyParam
        ? (validatedParams as Record<string, unknown>)[dedupeKeyParam]
        : undefined
      const dedupeKeyValue = typeof rawDedupeKey === "string" ? rawDedupeKey.trim() : ""
      const sameRequesterOnly =
        dedupeKeyParam !== undefined &&
        approvalDedupeSameRequesterRegistry.get([opts.orgId, appName, name]) === true
      // A tainted proposal restages only the SAME requester's pending row, and narrows it in
      // place to holders of the union taint (rule 8g, restage.ts): editing a pending payload is
      // not a disclosure, it stays pending under that approval.
      if (dedupeKeyParam && dedupeKeyValue !== "") {
        approvalRequestId = await findExistingPendingApprovalByDedupeKey({
          orgId: opts.orgId,
          toolName: opts.toolName,
          keyParam: dedupeKeyParam,
          keyValue: dedupeKeyValue,
          // The identity createApprovalRequest would record on a new row.
          ...(sameRequesterOnly || parkTaint !== null
            ? {
                sameRequester: {
                  requestedBy: userId,
                  agentId: persistableAgentId(actingAgentId),
                  routineId: currentRunContext()?.routineId ?? null,
                },
              }
            : {}),
        })
      }
      // ONE pending approval per keyed action, whoever staged it. A pending one this call may not
      // restage (another requester's, under `approvalDedupeSameRequester`, or any one when this
      // turn is tainted) is never overwritten, and it is not doubled either: the call is refused
      // naming it, so the caller can point the person at it or edit it. Walk 2026-10-19: a ticket
      // already holding a pending reply draft got a second one from the person's own agent.
      if (
        approvalRequestId === null &&
        dedupeKeyParam &&
        dedupeKeyValue !== "" &&
        (sameRequesterOnly || parkTaint !== null)
      ) {
        const othersPending = await findExistingPendingApprovalByDedupeKey({
          orgId: opts.orgId,
          toolName: opts.toolName,
          keyParam: dedupeKeyParam,
          keyValue: dedupeKeyValue,
        })
        if (othersPending !== null) {
          if (idemKey) await invalidateIdempotency(opts.orgId, opts.toolName, idemKey)
          return {
            error: {
              code: "approval_already_pending",
              message: alreadyPendingMessage({
                toolName: opts.toolName,
                keyParam: dedupeKeyParam,
                keyValue: dedupeKeyValue,
                approvalRequestId: othersPending,
                editableFields: (
                  approvalEditableFieldsRegistry.get([opts.orgId, appName, name]) ?? []
                ).map((f) => f.field),
              }),
              retryable: false,
              status: 409,
            },
          }
        }
      }
      if (approvalRequestId !== null) {
        // RESTAGE-IN-PLACE: the dedupe hit re-surfaces the existing pending
        // approval, but this call's params may DIFFER from the stored payload
        // (the agent restaged the keyed action with, e.g., a different carrier
        // offer). Returning the fresh `summary` below while leaving the stored
        // tool_params/current_payload/summary untouched told the agent the NEW
        // action was staged while the human's card (and the post-approval
        // execution) still carried the OLD one — the agent-vs-card divergence
        // class. Update the stored approval to this call's params + summary
        // (no-op when identical); prior sign-offs reset and the thread gets an
        // audit system message, mirroring the payload-edit path.
        // Dynamic import on purpose: a top-level `~/modules/approvals/restage`
        // edge from this module (which the boot path evaluates very early)
        // closed an ESM cycle through the approvals/threads modules and made
        // `eligibleApproversWithDimension` unresolved at prod boot (crash-loop
        // caught live 2026-07-16; test entry order never hit it). The dedupe
        // branch is rare and non-hot, so the lazy edge costs nothing.
        const { restagePendingApproval } = await import("~/modules/approvals/restage")
        const restaged = await restagePendingApproval({
          orgId: opts.orgId,
          requestId: approvalRequestId,
          // Invariant K, as in createApprovalRequest: a restaged mail send from an
          // encrypted personal mailbox replaces the stored draft with a sealed one,
          // bound to the id of the row it updates, never with the call's plaintext.
          toolParams: await sealMailApprovalPayload({
            orgId: opts.orgId,
            appName,
            toolShortName: name,
            approvalRequestId,
            toolParams: validatedParams as Record<string, unknown>,
          }),
          summary: summary as unknown as Record<string, unknown>,
          actorUserId: userId,
          actingAgentId,
          ...(parkTaint ? { turnTaint: parkTaint } : {}),
        })
        if ("taintRefusal" in restaged) {
          if (idemKey) await invalidateIdempotency(opts.orgId, opts.toolName, idemKey)
          if (taintFrame) taintFrame.scopeTaintRefused = true
          return {
            error: markPlatformTaintRefusal({
              code: "E_SCOPE_TAINT_BLOCKED",
              message: `tool ${opts.toolName}: ${restaged.taintRefusal}`,
              retryable: false,
              status: 403,
            }),
          }
        }
      }
      if (approvalRequestId === null) {
        approvalRequestId = await createApprovalRequest({
          orgId: opts.orgId,
          // Creates the fallback surface thread ONLY on this arm — the dedupe
          // hit above must not leave an orphan behind.
          threadId: await ensureApprovalThreadId(),
          toolName: opts.toolName,
          toolParams: validatedParams,
          defaultedParams,
          requestedBy: userId,
          reason: "gated",
          summary,
          appName,
          toolShortName: name,
          requesterCanApprove,
          approveScope,
          dimensionConstraint,
          origin: opts.origin,
          bundleId: opts.stepBundleId ?? null,
          tighten: approvalTighten,
          proposingTurnScopes: opts.turnTaintScopes,
          ...(opts.spawnParentFrame !== undefined
            ? { originRun: opts.spawnParentFrame?.run ?? null }
            : {}),
          ...(parkTaint
            ? {
                audienceMustHold: parkTaint,
                taintDisclosedToReaders,
                ...(taintPostSnapshot ? { taintDisclosureAudience: taintPostSnapshot } : {}),
              }
            : {}),
          actingAgentId,
          ...(autoCreatedApprovalId ? { id: autoCreatedApprovalId } : {}),
        })
      }
      envelope = {
        blocked: {
          reason: "gated",
          approvalRequestId,
          summary,
          // The row's real audience: an owner-routed approval (a personal
          // resource of the requester) is decided by the requester alone even
          // without the approve scope, so the agent must tell THEM to decide.
          requesterCanApprove:
            requesterCanApprove || (await approvalOwnedBy(opts.orgId, approvalRequestId, userId)),
          ...buildSequencingOutputs(tool, approvalRequestId),
        },
      }
    } else {
      // refs.length > 0 implies `mustSequence`, and a threadless mustSequence
      // call already returned "threadId required" above — so the caller's own
      // thread is always present here (the lazy fallback never fires for a
      // sequenced step).
      const seqThreadId = effectiveThreadId as string
      const stepBundleId: string | null = opts.stepBundleId ?? null
      let bundle: { bundleId: string; dependsOnId: string; position: number }
      try {
        if (stepBundleId === null) {
          // FLAG-OFF — preserve today's sequenced-bundle behavior byte-identically.
          bundle = await resolveBundleForRefs(opts.orgId, seqThreadId, userId, refs, actingAgentId)
        } else {
          // FLAG-ON — the new step's bundle is THIS step's bundle (allocated by the
          // agent stream loop), not the source approval's bundle. The dep edge is
          // recorded as `dependsOnId`. Multi-source refs in one call are rejected
          // as `invalid_ref` (same code path as resolveBundleForRefs's
          // bundleIds.size !== 1 check).
          const sourceApprovalId = await validateRefSources(opts.orgId, seqThreadId, userId, refs)
          bundle = {
            bundleId: stepBundleId,
            dependsOnId: sourceApprovalId,
            position: -1, // allocated inside createSequencedApprovalStep
          }
        }
      } catch (err) {
        // A bad @ref must surface as a clean, retryable-by-the-agent tool error
        // (HTTP 400) — never an uncaught 500 — and must release the idempotency
        // reservation so a retry without chaining is not blocked. Genuine
        // (non-invalid_ref) errors still propagate untouched.
        if ((err as { code?: unknown })?.code !== "invalid_ref") throw err
        if (idemKey) await invalidateIdempotency(opts.orgId, opts.toolName, idemKey)
        return {
          error: {
            code: "invalid_ref",
            message: err instanceof Error ? err.message : "invalid_ref",
            retryable: false,
          },
        }
      }
      const approvalRequestId = await createSequencedApprovalStep({
        orgId: opts.orgId,
        threadId: seqThreadId,
        toolName: opts.toolName,
        toolParams: validatedParams,
        requestedBy: userId,
        summary,
        appName,
        toolShortName: name,
        approveScope,
        dimensionConstraint,
        bundle,
        proposingTurnScopes: opts.turnTaintScopes,
        actingAgentId,
      })
      envelope = {
        blocked: {
          reason: "gated",
          approvalRequestId,
          summary,
          requesterCanApprove,
          sequenced: true,
          ...buildSequencingOutputs(tool, approvalRequestId),
        },
      }
    }
    // D18: what the gated tool has the proposing agent relay (e.g. a node
    // routine's guardrail risk note), added beside the pending approval.
    if ("blocked" in envelope) {
      Object.assign(
        envelope.blocked,
        await gatedAgentNotesFor(tool, validatedParams, {
          orgId: opts.orgId,
          userId,
          scopes: actorScopes,
        }),
      )
    }
    if (idemKey)
      await finalizeIdempotency(opts.orgId, opts.toolName, idemKey, validatedParams, envelope)
    return envelope
  }

  try {
    // Bridge-owned transactions: the handler gets a SESSION, not a live
    // transaction. Sandboxed handlers open a short RLS tx per bridge call
    // (createSessionRpcBridge), so no pool connection is pinned across sandbox
    // IPC / external HTTP / Meili — pool demand tracks SQL time, not handler
    // wall-clock. Tools declaring `atomic: true`, host-side handlers, and the
    // preflight/approved-re-entry paths still run whole-handler transactions
    // (executeToolHandler materializes one from this same session).
    const result = await runWithTransientRetry(
      () =>
        executeToolHandler(
          tool,
          tool.handler,
          userId,
          opts.orgId,
          actorScopes,
          createRlsSession(actorForRls),
          validatedParams,
          undefined,
          {
            callChain: innerChain,
            parentExecutionToken: opts.parentExecutionToken,
            taintState: opts.taintState,
            actor: actorForRls,
            threadId: opts.threadId,
            origin: opts.origin, // propagate MCP/in-app-agent attribution (main handler site)
            // The gate-relevant half of "a human authorized this": a direct
            // human-UI call whose user ALSO holds the approve scope (the same
            // pair computeSkipGate's human-UI bypass requires). Only that pair
            // may be carried into a nested declared cross-app dispatch.
            humanAuthorized: isDirectHumanCall && requesterCanApprove,
            ...(opts.spawnParentFrame !== undefined
              ? { spawnParentFrameOverride: opts.spawnParentFrame }
              : {}),
            // A person's own direct call (no cross-app hop above it, so
            // `opts.actor` is the person and not a hop's widened RLS actor):
            // their own scopes decide a handler-requested approval.
            ...(isDirectHumanCall &&
            opts.actor.actorType === "user" &&
            (opts.callChain ?? []).length === 0 &&
            (callerApp == null || callerApp === appName)
              ? { personScopes: [...opts.actor.scopes] }
              : {}),
            callerApp, // declared cross-app origin (undefined for direct calls)
            // A45, FX22 F6: and whether that declared call is one of the kernel's
            // recognised INGESTION paths, which is the only thing a handler may skip
            // an approval gate for. Computed here because only this function knows
            // both halves (the caller, and that the caller declared this target).
            ingestionCallerApp: ingestionCallerApp({
              callerApp,
              toolName: opts.toolName,
              declared: approvedCrossAppCall,
            }),
            // A verified provider-contract dispatch: the caller's files the op names, which the
            // provider may read (multipart parts), and nothing else of the caller's.
            ...(approvedContractCall && contractCall?.files?.length
              ? { contractFileGrant: [...contractCall.files] }
              : {}),
            // A verified provider-contract dispatch whose op names a file target: the provider may
            // store a file onto that ONE caller record (files_importFromUrl), nothing else.
            ...(approvedContractCall && callerApp && contractCall
              ? contractFileTargetOptions(callerApp, contractCall, validatedParams)
              : {}),
            priority: opts.priority, // propagate worker-pool scheduling class (main handler site)
            nested: isNestedDispatch, // reentrancy admission (main handler site)
            signal: opts.signal,
            actingAgentId, // FX3-1: the agent this dispatch acts as (main handler site)
            turnTaintScopes: handlerTurnTaint,
          },
        ),
      tool.retryOnTransientDbError === true,
      opts.toolName,
    )

    const handlerError = normalizeToolErrorResult(result)
    if (handlerError) {
      envelope = { error: handlerError }
    } else if (tool.returns?.schema && result) {
      if (!validateToolResult(result, tool.returns.schema)) {
        envelope = {
          error: {
            code: "tool_output_invalid",
            message: "Tool output failed validation",
            retryable: false,
          },
        }
      } else {
        envelope = applyResponseFilter(tool, opts, result)
      }
    } else {
      envelope = applyResponseFilter(tool, opts, result)
    }

    if ("data" in envelope && tool.taintSource && opts.threadId) {
      try {
        await markThreadsForTaintSourceResult(
          tool,
          validatedParams,
          opts.orgId,
          [opts.threadId, opts.alsoJudgeTaintOnThreadId],
          opts.toolName,
        )
      } catch (err) {
        // Fail closed: untrusted text that reaches the model without the turn being marked would
        // let the next outward action run unparked. The read is withheld instead.
        log.error(
          { err, threadId: opts.threadId, toolName: opts.toolName },
          "Failed to set taint flag after taintSource tool: result withheld",
        )
        envelope = {
          error: {
            code: "taint_record_failed",
            message: `${opts.toolName}: the result was withheld because this conversation could not be marked as having read outside content (${err instanceof Error ? err.message : String(err)}). Retry the same call.`,
            retryable: true,
          },
        }
      }
    }
  } catch (err) {
    if (idemKey) await invalidateIdempotency(opts.orgId, opts.toolName, idemKey)
    const message = err instanceof Error ? err.message : "Tool handler error"
    // A connection with no stored credentials (a send from a mailbox added
    // without its password): the person reconnects it. Typed, whichever handler
    // (host or sandboxed, where only the message crossed back) hit it.
    const missingCredentials = ConnectionCredentialsMissingError.fromMessage(message)
    if (missingCredentials) {
      log.warn({ toolName: opts.toolName }, "Tool needs a connection with stored credentials")
      return {
        error: {
          code: missingCredentials.code,
          message: missingCredentials.message,
          retryable: false,
          status: missingCredentials.status,
        },
      }
    }
    // Recognize error codes raised by app-level triggers/constraints (e.g.
    // `RAISE EXCEPTION 'category_depth_limit'`). The exception aborts the
    // transaction, so the inner handler can't catch and return cleanly — the
    // outer DB transaction wrapper rethrows the original PostgresError here.
    const knownCodes = new Set([
      "category_depth_limit",
      "inbox_email_taken",
      "archived_category",
      "archived_inbox",
    ])
    if (typeof message === "string" && knownCodes.has(message)) {
      return { error: { code: message, message, retryable: false } }
    }
    if (
      typeof message === "string" &&
      message.includes("duplicate key value") &&
      message.includes("inboxes_")
    ) {
      return {
        error: {
          code: "inbox_email_taken",
          message: "inbox email already in use",
          retryable: false,
        },
      }
    }
    // An app's `document_ref` partial-unique index (e.g. Boxtal's
    // `uniq_app_boxtal_shipment_document_ref`, which enforces one live shipment
    // per invoice) can be violated by a concurrent reservation. The violation
    // aborts the transaction, so the app's own check-then-insert catch can't
    // return cleanly — surface it as the `duplicate` envelope the app intends
    // (no double-create), not an opaque `tool_error`.
    if (
      typeof message === "string" &&
      message.includes("duplicate key value") &&
      /uniq_[a-z0-9_]*app_[a-z0-9_]*_document_ref/.test(message)
    ) {
      return {
        error: {
          code: "duplicate",
          message: "A resource is already in flight for this reference.",
          retryable: false,
        },
      }
    }
    // BL-180: a TRANSIENT write-contention / connection error (serialization 40001, deadlock 40P01,
    // a connection blip) aborts the transaction ATOMICALLY — nothing committed — so re-issuing the
    // SAME call (a fresh transaction) is correct, not a duplicate. The generic branch below would
    // surface it as retryable:false, which tells the weak agent NOT to retry a recoverable error →
    // it gives up or FABRICATES success (chaos: several projects__create in one turn, some land,
    // some return "Failed query"). Mark it retryable + log the REAL cause (the postgres.js "Failed
    // query" wrapper's own message is just the SQL text; the SQL state lives on `.cause.code`). Pool
    // exhaustion is deliberately NOT classified transient (fix capacity, don't mask — BL-131 lesson).
    if (isTransientDbError(err)) {
      const cause = describeDbError(err)
      log.warn(
        { toolName: opts.toolName, dbCode: cause.code, dbMessage: cause.message },
        "Transient DB error on tool handler — surfaced as retryable (BL-180)",
      )
      return {
        error: {
          code: "transient_db_error",
          message:
            "A transient database write-contention error occurred; this call did NOT take effect. Retry the SAME call once.",
          retryable: true,
        },
      }
    }
    // A bad-input SQLSTATE (22P02 invalid text representation — e.g. an agent
    // passing a document TITLE where a uuid id is expected — 22007 bad datetime,
    // 22003 numeric out of range) is a caller error the agent can correct, not a
    // server fault. Without this branch it falls to the statusless generic path
    // below: error-level log (watchdog critical) + opaque tool_error. Surface it
    // as a typed invalid_params instead, warn-logged.
    {
      // pgErrorFacts reads the SQLSTATE and the server's own message off the
      // live cause chain OR off the message-only rewrap withPgCause builds
      // (sandbox/bridge/shared.ts) — `.cause` cannot survive the sandbox worker
      // IPC, so the trailing "(XXXXX)" in the text is all a host sees there.
      const facts = pgErrorFacts(err)
      const BAD_INPUT_SQLSTATES = new Set(["22P02", "22007", "22003"])
      const badInputCode = facts?.code ?? /\(([0-9A-Z]{5})\)\s*$/.exec(message)?.[1] ?? null
      if (badInputCode && BAD_INPUT_SQLSTATES.has(badInputCode)) {
        log.warn(
          { toolName: opts.toolName, dbCode: badInputCode, dbMessage: message },
          "Tool handler DB bad-input error — surfaced as invalid_params",
        )
        return {
          error: {
            code: "invalid_params",
            // Only the server's message (e.g. `invalid input syntax for type
            // uuid: "none"`), never the "Failed query: <sql> params: …" text.
            message: `A parameter has the wrong format for this tool (${facts?.message ?? "invalid input"}). Check id/date/number parameters (entity ids must be the UUID, not a name or title), and retry with corrected values.`,
            retryable: true,
          },
        }
      }
    }
    // Any OTHER database error (constraint violation, RLS denial, a bug in a
    // query). Drizzle's message is "Failed query: <sql>\nparams: <values>", and a
    // trusted app's message reaches the caller verbatim below — so without this
    // branch an agent saw the raw SQL, the schema and every bound value (tenant
    // ids included). Map it to a typed, SQL-free error; keep the detail in the log.
    {
      const safeDb = callerSafeDbError(err)
      if (safeDb) {
        const logFn = safeDb.status < 500 ? log.warn : log.error
        logFn.call(
          log,
          {
            err,
            toolName: opts.toolName,
            dbCode: safeDb.facts.code,
            dbMessage: safeDb.facts.message,
            constraint: safeDb.facts.constraintName,
            innerMessage: message,
          },
          "Tool handler DB error — detail withheld from the caller",
        )
        return {
          error: {
            code: safeDb.code,
            message: safeDb.message,
            retryable: safeDb.retryable,
            status: safeDb.status,
          },
        }
      }
    }
    // DELIBERATE safe tool errors (app-sdk `ToolError`). A sandboxed handler can
    // opt a specific, caller-actionable message OUT of the untrusted-prod redaction
    // by throwing a `ToolError`: the handler author has vetted that message as safe
    // (no secrets/internals). The sandbox worker + pool carry the `safe`/`code`/
    // `retryable` marker across the QuickJS + IPC boundary (see sandbox-worker.ts /
    // worker-pool.ts), and a host-side (trusted) handler can throw one directly.
    // Surface the REAL message + code so a weak model can correct the call instead
    // of blindly retrying an opaque "Tool execution failed" (the token-runaway
    // class). This is the ONLY opt-out of the no-leak default: a bare `throw new
    // Error(...)` still redacts below. warn-log (deliberate rejection, not a fault).
    if (
      (err as { safe?: unknown })?.safe === true &&
      typeof (err as { message?: unknown })?.message === "string"
    ) {
      const safeErr = err as {
        message: string
        code?: unknown
        retryable?: unknown
        status?: unknown
      }
      const safeCode = typeof safeErr.code === "string" ? safeErr.code : "tool_error"
      log.warn(
        { toolName: opts.toolName, code: safeCode, message: safeErr.message },
        "Tool handler threw a safe ToolError",
      )
      // A 4xx the handler named (an upstream throttle or refusal) keeps its
      // class; otherwise the code map's default 500 reads as a server fault.
      const safeStatus =
        typeof safeErr.status === "number" && safeErr.status >= 400 && safeErr.status < 500
          ? safeErr.status
          : undefined
      return {
        error: {
          code: safeCode,
          message: safeErr.message,
          retryable: safeErr.retryable === true,
          ...(safeStatus !== undefined ? { status: safeStatus } : {}),
        },
      }
    }
    // Untrusted (sandboxed) handler internals are hidden from the caller in production. In chaos
    // (CHAOS_DEBUG=1 is set on the spawned server) surface the REAL error so a sandboxed-handler
    // crash is debuggable instead of an opaque "Tool execution failed" — the drafts_create
    // export-payload crash class. Production + the sandbox-worker test (no CHAOS_DEBUG) stay opaque.
    const isUntrustedProd =
      isManifestHandler(tool.handler) && tool.handler.trusted === false && !process.env.CHAOS_DEBUG
    // DELIBERATE sandboxed-handler errors. Sandboxed apps communicate agent-actionable
    // failures by throwing `some_error_code: human guidance` (e.g. invoicing's
    // `no_issuer_profile: …`), but the sandbox IPC marshals only the message STRING —
    // code/status don't survive the worker boundary — so without this branch the
    // untrusted-prod redaction flattens them to an opaque "Tool execution failed".
    // The agent then can't see WHY the call failed and a weak model blindly retries
    // the same doomed write for dozens of full-context steps (the token-runaway
    // class). A code-prefixed message is the app's own agent-facing surface, not
    // handler internals — preserve it as a typed non-retryable 422 and warn-log
    // (deliberate rejection, not a server fault). Genuine crashes (no code prefix:
    // "undefined is not a function", timeouts, bundle-eval errors) stay redacted.
    const deliberateSandboxCode = isUntrustedProd
      ? classifyDeliberateSandboxError(message)
      : undefined
    if (isUntrustedProd && deliberateSandboxCode) {
      log.warn(
        { toolName: opts.toolName, code: deliberateSandboxCode, innerMessage: message },
        "Sandboxed tool handler threw a deliberate typed error",
      )
      return {
        error: { code: deliberateSandboxCode, message, retryable: false, status: 422 },
      }
    }
    // Sandbox TIMEOUT is operational state, not handler internals — redacting it
    // to the generic "Tool execution failed" leaves the caller (and the human
    // clicking the button) with zero signal that the tool simply ran past its
    // budget (the boxtal print_pack 8s-default class). Surface it as a typed,
    // retryable timeout; the message leaks nothing about the handler.
    if (isUntrustedProd && message === "App execution timed out") {
      log.warn({ toolName: opts.toolName }, "Sandboxed tool handler timed out")
      return {
        error: {
          code: "timeout",
          message: `${opts.toolName} timed out while executing. Retry once; if it persists, the operation is genuinely slow or stuck.`,
          retryable: true,
          status: 504,
        },
      }
    }
    // A failure that followed an upstream error answer: the app's own error
    // (Google's reason and the fix, say) reaches the caller sanitized and
    // bounded; a runtime crash names the connection and the host it called
    // (configuration, not handler internals), so a stale base URL is visible.
    const upstreamFailure = upstreamFailureOf(err)
    if (upstreamFailure) {
      log.warn(
        {
          toolName: opts.toolName,
          app: tool.appName,
          connection: upstreamFailure.connection?.name,
          connectionIdentifier: upstreamFailure.connection?.identifier,
          upstreamHost: upstreamFailure.host,
          upstreamStatus: upstreamFailure.status,
        },
        "Tool handler failed after an upstream error answer",
      )
    }
    const publicMessage = isUntrustedProd
      ? upstreamFailure
        ? upstreamFailureMessage(tool.appName, upstreamFailure, err, message)
        : "Tool execution failed"
      : message
    // Expected CALLER-CONTEXT errors — a tool that structurally requires
    // in-process agent state (e.g. spawn_agent's `SpawnAgentContextError` when
    // ctx.agentExecutionThreadId is missing) throws a typed, non-retryable
    // error carrying a recognizable `code`. This is a caller mistake, not an
    // unexpected exception — the handler already warn-logged with its own
    // context (see spawn-agent-tool.ts), so log at warn here too (not the
    // generic error-level "Tool handler threw" below, which pages the
    // watchdog). Recognized by the `code` + `retryable:false` marker shape so
    // future tools can opt in without a per-tool special case here.
    const expectedCallerErrorCodes = new Set([
      "invalid_context",
      // A fail closed agent to agent delegation: the callee stopped being a
      // live agent between the guard and the hand off, so the turn is refused
      // rather than run at the callee's own ceiling. The guard already warned
      // with its own context; pages nobody.
      AGENT_DELEGATION_UNAVAILABLE,
    ])
    const errCode =
      typeof (err as { code?: unknown })?.code === "string"
        ? (err as { code: string }).code
        : undefined
    if (
      errCode &&
      expectedCallerErrorCodes.has(errCode) &&
      (err as { retryable?: unknown }).retryable === false
    ) {
      log.warn(
        { toolName: opts.toolName, code: errCode, message },
        "Tool handler threw an expected caller-context error",
      )
      return { error: { code: errCode, message: publicMessage, retryable: false } }
    }
    // Error reporting & field observability (docs/conventions.md, BINDING): preserve a DELIBERATE
    // typed error's HTTP classification — a throw carrying a numeric `status` (e.g. a 422 with a
    // code + upstream body) — so its status/code/body reach the agent + the log instead of being
    // flattened to tool_error/500. Incidental errors (pg/node — a string `.code` but NO numeric
    // `.status`) still flatten, so internal codes never leak as tool error codes; an untrusted
    // sandboxed handler in production stays redacted (publicMessage) per the no-leak rule.
    const te = err as { status?: unknown; code?: unknown; body?: unknown }
    const typedStatus = typeof te?.status === "number" ? te.status : undefined
    // Severity follows the HTTP class. A DELIBERATE typed 4xx (validation,
    // not-found, forbidden, conflict) is a caller/agent error the agent gets back
    // and can correct — not a server fault. Logging it at `error` (level 50) makes
    // the prod watchdog treat every such rejection as a new-signature CRITICAL and
    // forward it to the ops attention feed as noise. Log 4xx at `warn`; reserve
    // `error` (which pages the watchdog) for 5xx and unclassified throws — the
    // genuine faults. The agent-facing envelope below is unchanged either way.
    // An upstream that dropped the connection (after egress's one retry) is an
    // outage the caller retries, not our fault: warn as well.
    // A caller that went away and an upstream 503 are expected too (lib/failure-severity.ts).
    logFailure(
      log,
      { status: typedStatus, code: te?.code, err },
      { err, toolName: opts.toolName, status: typedStatus, code: te?.code, innerMessage: message },
      "Tool handler threw",
    )
    // The pool refused the call before the handler ran (the org's custom apps
    // used their sandbox share, worker-pool.ts): a host refusal, not handler
    // text, so it keeps its code and message even for an untrusted app.
    if (err instanceof SandboxTenantBusyError) {
      return {
        error: {
          code: SANDBOX_TENANT_BUSY_CODE,
          message: err.message,
          retryable: true,
          status: 429,
        },
      }
    }
    if (typedStatus !== undefined && !isUntrustedProd) {
      return {
        error: {
          code: typeof te.code === "string" ? te.code : "tool_error",
          message: publicMessage,
          retryable: false,
          status: typedStatus,
          body: te.body,
        },
      }
    }
    // A redacted sandboxed throw still carries its HTTP class: a number, not
    // handler text, so the caller can tell an upstream 4xx from a crash.
    return {
      error: {
        code: "tool_error",
        message: publicMessage,
        retryable: false,
        ...(typedStatus !== undefined ? { status: typedStatus } : {}),
      },
    }
  }

  // When the gate was skipped because an auto-approve policy fired (not the
  // human bypass), record a synthetic `approval_request` pre-set to `approved`
  // and tagged `autoApprovedByPolicy:<id>` so every autonomous approval leaves
  // the same audit trail a human approval would. Best-effort — a failure here
  // must not fail the (already-executed) tool call.
  if (autoApprovedByPolicy && opts.threadId && "data" in envelope && userId !== "system") {
    try {
      await writeSyntheticPolicyApproval({
        orgId: opts.orgId,
        threadId: opts.threadId,
        toolName: opts.toolName,
        toolParams: validatedParams,
        requestedBy: userId,
        appName,
        policyId: autoApprovedByPolicy,
        proposingTurnScopes: opts.turnTaintScopes,
        actingAgentId,
      })
    } catch (err) {
      log.error(
        { err, toolName: opts.toolName, policyId: autoApprovedByPolicy },
        "Failed to record synthetic auto-approve approval row",
      )
    }
  }

  // Same audit-row pattern for the machine-authorized cross-app arm. This is
  // the path the boxtal webhook -> shopify:fulfillments_create call now takes
  // (a "system" origin dispatch, no thread): the FK-bound approval_requests
  // row needs a real thread and a real user, neither of which a webhook has,
  // so it can only be written when one is present (e.g. a routine-tick or job
  // context that does carry a thread). The threadless case still stays
  // traceable via the structured log below — execution itself is never
  // withheld either way.
  if (autoApprovedByCapability && "data" in envelope) {
    if (opts.threadId && userId !== "system") {
      try {
        await writeSyntheticCapabilityApproval({
          orgId: opts.orgId,
          threadId: opts.threadId,
          toolName: opts.toolName,
          toolParams: validatedParams,
          requestedBy: userId,
          appName,
          callerApp: autoApprovedByCapability,
          ...(capabilityHumanAuthorization
            ? { humanAuthorization: capabilityHumanAuthorization }
            : {}),
        })
      } catch (err) {
        log.error(
          { err, toolName: opts.toolName, callerApp: autoApprovedByCapability },
          "Failed to record synthetic capability-approval row",
        )
      }
    } else {
      log.info(
        { toolName: opts.toolName, callerApp: autoApprovedByCapability, orgId: opts.orgId },
        "machine-authorized cross-app call auto-executed with no thread/user context for an audit row",
      )
    }
  }

  if (idemKey) {
    if ("error" in envelope) {
      await invalidateIdempotency(opts.orgId, opts.toolName, idemKey)
    } else {
      await finalizeIdempotency(opts.orgId, opts.toolName, idemKey, validatedParams, envelope)
    }
  }

  log.info(
    {
      chain: innerChain,
      target: opts.toolName,
      outcome:
        "data" in envelope
          ? "data"
          : "blocked" in envelope
            ? "blocked"
            : `error:${envelope.error.code}`,
    },
    "cross_app_call",
  )

  // A46b. The read's origin is filed HERE, once the read has actually happened and
  // from what it RETURNED, never from what its arguments asked for. Everything that
  // can go wrong before this point -- a validation failure, a scope refusal, an
  // approval gate, an RLS-invisible or nonexistent row, a handler throw -- returned
  // earlier, so it files nothing and cannot widen a later write. `taintOriginOf`
  // adds the rest of the rule: the tool must declare the table and the row, must
  // have contributed requiredScopes to the turn, and only the rows it returned are
  // filed. Filing into the LIVE store means every path into the core contributes --
  // an agent tool call, an MCP call, a nested ctx.executeTool read inside a sandbox.
  if ("data" in envelope && isReadOnlyTool(tool) && taintOriginStore) {
    const readOrigin = taintOriginOf(tool, validatedParams, envelope.data)
    if (readOrigin) taintOriginStore.recordOriginRows(readOrigin.table, readOrigin.rowIds)
  }

  return envelope
}

/**
 * A conditionally gated tool parks itself: its handler asks for the approval
 * (`ctx.requestApproval`) and returns `{ status: "pending_approval", approval_id }`
 * as plain data, never the kernel's `blocked` envelope. Without the @ref tokens
 * the kernel gate hands out, the agent could not chain a later step on it (a
 * quote parked by the invoicing threshold, then the reply attaching its PDF):
 * the same `outputs` and `hint` are added here.
 */
export function withHandlerApprovalOutputs(
  tool: Pick<NonNullable<ReturnType<typeof toolRegistry.get>>, "referenceableOutputs">,
  result: unknown,
): unknown {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return result
  const r = result as Record<string, unknown>
  if (r.status !== "pending_approval" || typeof r.approval_id !== "string") return result
  if ("outputs" in r) return result
  const extra = buildSequencingOutputs(tool, r.approval_id)
  return extra.outputs ? { ...r, ...extra } : result
}

function applyResponseFilter(
  tool: NonNullable<ReturnType<typeof toolRegistry.get>>,
  opts: ExecuteToolCoreOptions,
  raw: unknown,
): ExecuteToolEnvelope {
  const result = withHandlerApprovalOutputs(tool, raw)
  if (tool.returns?.dimensions && result) {
    const dimensionGrants = opts.actor.actorType === "user" ? opts.actor.dimensionGrants : {}
    const defs = returnsDimensionDefs(opts.orgId, tool.appName, tool.returns.dimensions)
    return { data: filterResponse(result, tool.returns.dimensions, dimensionGrants, defs) }
  }
  return { data: result }
}

/**
 * Classify an untrusted sandboxed handler's thrown MESSAGE as a deliberate,
 * agent-facing typed error (returns its code) vs an incidental crash (undefined
 * → stays redacted). Deliberate shape: a lowercase snake_case run then a colon
 * (`no_issuer_profile: …`; `invoicing:documents_get found no …` classifies with
 * code "invoicing" — imprecise, but the MESSAGE is what the agent needs).
 * Crash shapes don't match: `TypeError: …` starts uppercase, `unexpected
 * token: …` has a space before the colon, `App execution timed out` has no
 * colon-terminated prefix.
 */
export function classifyDeliberateSandboxError(message: string): string | undefined {
  return /^([a-z][a-z0-9_]{2,49}):\s*\S/.exec(message)?.[1]
}

// `TData` lets a caller assert the data payload shape its specific `toolName` returns (tool dispatch
// is dynamic, so the core can only type `data` as `unknown`). The default keeps the unannotated
// contract — `data: unknown` — for every existing caller; the single internal cast at the return
// boundary is the unavoidable dynamic-dispatch assertion, not a callsite escape hatch.
export async function executeTool<TData = unknown>(
  params: ExecuteToolParams,
): Promise<ExecuteToolResult<TData>> {
  const { agentId, ...rest } = params
  // Fail-closed default for a caller that passed no origin at all: never
  // "human-ui" (that literal is reserved for the REST entry, rest-tool-call.ts, where
  // the human click IS the approval). "in-app-agent" gates the same as any
  // other non-human origin, so an omitted origin can only ever be gated, never
  // silently bypass the approval check.
  const origin: ToolOrigin = params.origin ?? "in-app-agent"
  const envelope = await executeToolCore({
    ...rest,
    origin,
    callChain: [],
    internalCall: undefined,
    // `undefined` keeps the in-frame read; a value overrides it, which is the
    // only answer a frameless gateway call has.
    ...(agentId !== undefined ? { actingAgentId: agentId } : {}),
  })
  if ("error" in envelope) {
    // Not connected is an answer, not a failure: see isNotConnectedToolErrorCode.
    if (isNotConnectedToolErrorCode(envelope.error.code)) {
      return {
        data: {
          error: { code: envelope.error.code, message: envelope.error.message },
        } as TData,
      }
    }
    const status = envelope.error.status ?? statusForToolError(envelope.error.code)
    const err = new Error(envelope.error.message) as Error & {
      status: number
      code: string
      body?: unknown
      details?: { retryable: boolean }
    }
    err.status = status
    err.code = envelope.error.code
    if (envelope.error.body !== undefined) err.body = envelope.error.body
    err.details = { retryable: envelope.error.retryable }
    // A tenant's sandbox share is full (worker-pool.ts): the client retries after one wait.
    if (envelope.error.code === SANDBOX_TENANT_BUSY_CODE) {
      ;(err as Error & { retryAfterSeconds?: number }).retryAfterSeconds =
        SANDBOX_TENANT_RETRY_AFTER_SECONDS
    }
    if (isPlatformTaintRefusal(envelope.error)) markPlatformTaintRefusal(err)
    if (wasRefusedBeforeRun(envelope.error, params.toolName)) {
      markRefusedBeforeRun(err, params.toolName)
    }
    throw err
  }
  if ("blocked" in envelope) return { data: null as TData, blocked: envelope.blocked }
  return { data: envelope.data as TData }
}

/**
 * Approved-handler entrypoint. Runs only the post-gate execution tail of executeTool():
 * params re-validation → handler dispatch → output validation → taint post-hook → response filtering.
 * The decide service supplies approval context so the sandbox bridge exposes the idempotency methods.
 */
export async function executeApprovedToolHandlerInternal(args: {
  tool: NonNullable<ReturnType<typeof toolRegistry.get>>
  orgId: string
  userId: string
  actorScopes: string[]
  tx: any
  payload: unknown
  approvalContext: {
    approvalRequestId: string
    approvalDeciderId: string
    toolName: string
    approvalExecutionId?: string
    /** The routine that RAISED this approval (captured at request time). */
    originRoutineId?: string
  }
  /** Originating surface recorded on the approval (spec C7). When "mcp", the
   *  decided mutation's bridge actorType is stamped "mcp" so a gated
   *  MCP-originated mutation audits as actorType:"mcp" (success criterion 7),
   *  even though the decider is a user. undefined/"in-app-agent" preserves the
   *  pre-Phase-12 default attribution — no behavior change for the in-app agent. */
  origin?: ToolOrigin
  /**
   * The app-aliased EXECUTION actor (the requester aliased for the target app,
   * carrying their full dimension grants) — see
   * run-approved-handler.approvalExecutionActor. Forwarded into the handler
   * bridge so a NESTED cross-app `ctx.executeTool` (e.g. a gated invoicing
   * `documents_send_to_customer` → `mail:compose`) inherits the requester's
   * real dimension grants. This MIRRORS the direct (non-gated) tool path, which
   * passes `actor: actorForRls` as `bridgeOptions.actor`. Without it the
   * sandbox bridge's `inheritedActor` falls back to `dimensionGrants: {}`
   * (rpc-bridge.ts), so the cross-called mail handler cannot see the
   * dimension-gated org mailbox and fails closed with NOT_FOUND ([[BL-186]]).
   */
  actor?: ActorContext
  /**
   * The thread the original request was raised on. Forwarded into the handler
   * bridge's `bridgeOptions.threadId` so a NESTED gated call made inside an
   * approved handler (e.g. invoicing's convert-to-order handler calling
   * `shopify:draft_orders_complete`) can at least park an approval instead of
   * failing "Tool is gated — threadId required" and wedging the OUTER approval
   * back to pending (approvals/decide.ts revertToPending).
   */
  threadId?: string
}): Promise<unknown> {
  const validated = validateParamsForTool(
    args.tool,
    args.orgId,
    args.tool.appName,
    args.tool.name,
    args.payload,
  )
  // The approval-request-create event itself stays actorType:"user" (spec C7);
  // that is stamped at createApprovalRequest, not here. Here we only propagate
  // the recorded origin so the EXECUTED (post-approval) mutation — an
  // MCP-originated mutation per success criterion 7 — carries actorType:"mcp".
  //
  // A recorded "human-ui" is forwarded unchanged too: it is correct for the
  // decided mutation itself (a human really did request this, it just needed
  // someone else's approval). If that mutation's handler makes its own NESTED
  // cross-app call, rpc-bridge.ts's executeTool bridge is the single choke
  // point for every such call: it still downgrades "human-ui" to
  // "in-app-agent" for the nested dispatch's own origin (a replayed approval
  // cannot carry human provenance across an app boundary any more than a live
  // call can), but `approvalContext` being present here means the bridge also
  // marks the nested call `internalCall.humanAuthorized` — so a DECLARED
  // `cross_app_calls` target still executes deterministically instead of
  // parking its own approval (see execute-tool.ts's
  // `humanAuthorizedCrossAppCall`).
  return executeToolHandler(
    args.tool,
    args.tool.handler,
    args.userId,
    args.orgId,
    args.actorScopes,
    args.tx,
    validated,
    args.approvalContext,
    {
      ...(args.origin ? { origin: args.origin } : {}),
      ...(args.actor ? { actor: args.actor } : {}),
      ...(args.threadId ? { threadId: args.threadId } : {}),
    },
  )
}

/**
 * Whether a sequenced @ref step's data stays within its bundle heads' audience
 * (scope-taint.ts, rule 8f): every approval it cites belongs to a bundle whose
 * head is still pending, was requested by the same person, and already demands
 * of its audience (`metadata.taintAudienceMustHold`) every scope the step's turn
 * read. The head's deciders and notified people then hold the step's data, and
 * one approval of the head runs the step.
 */
export async function sequencedStepWithinHeadAudience(args: {
  orgId: string
  requesterUserId: string
  approvalIds: string[]
  taintScopes: readonly string[]
}): Promise<boolean> {
  const ids = [...new Set(args.approvalIds)]
  if (ids.length === 0 || args.taintScopes.some((s) => UNKNOWN_TURN_TAINT.includes(s))) {
    return false
  }
  const heads = await withPrivilegedDb(args.orgId, "sequenced-step-head-audience", async (tx) =>
    extractRows<{ ref_id: string; status: string; requested_by: string; metadata: unknown }>(
      await tx.execute(
        drizzleSql`SELECT r.id::text AS ref_id, h.status, h.requested_by::text AS requested_by, h.metadata
          FROM ${K}.approval_requests r
          JOIN ${K}.approval_requests h
            ON h.org_id = r.org_id AND h.id = COALESCE(r.bundle_id, r.id)
          WHERE r.org_id = ${args.orgId}::uuid
            AND r.id = ANY(${`{${ids.join(",")}}`}::uuid[])`,
      ),
    ),
  )
  if (heads.length !== ids.length) return false
  return heads.every((h) => {
    if (h.status !== "pending" || h.requested_by !== args.requesterUserId) return false
    const mustHold = new Set(
      rowTaintMustHold((h.metadata ?? null) as { taintAudienceMustHold?: unknown } | null),
    )
    return args.taintScopes.every((s) => mustHold.has(s))
  })
}

/**
 * A sequenced @ref step whose turn read more than its heads already demand (scope-taint.ts,
 * rule 10a, 2026-11-03): each head is the same requester's pending request, so its demand is
 * widened IN PLACE to the union, exactly as a tainted restage of that request would be (rule
 * 8g, narrowPendingApprovalForTaint): the notified audience is re-narrowed to holders of the
 * union, never widened, and the requester and somebody who may decide the head must hold it.
 * The step then lies within its heads' audience and parks with them. `notOwn` when a head is
 * not this requester's pending request (it cannot be narrowed by this turn); `message` when
 * narrowing it would leave nobody to decide it.
 */
export async function widenSequencedStepHeads(args: {
  orgId: string
  requesterUserId: string
  approvalIds: string[]
  taintScopes: readonly string[]
}): Promise<{ ok: true } | { ok: false; notOwn: true } | { ok: false; message: string }> {
  const ids = [...new Set(args.approvalIds)]
  if (ids.length === 0 || args.requesterUserId === "") return { ok: false, notOwn: true }
  const taint = [...new Set(args.taintScopes)].sort()
  return withPrivilegedDb(args.orgId, "sequenced-step-head-widen", async (tx) => {
    const heads = extractRows<{ id: string; status: string } & TaintNarrowRow>(
      await tx.execute(
        drizzleSql`SELECT h.id::text AS id, h.status, h.requested_by::text AS requested_by,
            h.tool_name, h.notify_user_ids, h.resource_owner_id::text AS resource_owner_id,
            h.approve_scope, h.dimension_constraint, h.metadata
          FROM ${K}.approval_requests h
          WHERE h.org_id = ${args.orgId}::uuid
            AND h.id IN (
              SELECT COALESCE(r.bundle_id, r.id) FROM ${K}.approval_requests r
              WHERE r.org_id = ${args.orgId}::uuid
                AND r.id = ANY(${`{${ids.join(",")}}`}::uuid[]))
          FOR UPDATE OF h`,
      ),
    )
    const cited = extractRows<{ n: number }>(
      await tx.execute(
        drizzleSql`SELECT count(*)::int AS n FROM ${K}.approval_requests
          WHERE org_id = ${args.orgId}::uuid AND id = ANY(${`{${ids.join(",")}}`}::uuid[])`,
      ),
    )[0]?.n
    if (
      heads.length === 0 ||
      cited !== ids.length ||
      heads.some((h) => h.status !== "pending" || h.requested_by !== args.requesterUserId)
    ) {
      return { ok: false, notOwn: true }
    }
    const narrowed: Array<{ id: string; mustHold: string[]; notifyUserIds: string[] }> = []
    for (const head of heads) {
      const narrowing = await narrowPendingApprovalForTaint(tx, args.orgId, head, taint)
      if (!narrowing.ok) return { ok: false, message: narrowing.message }
      narrowed.push({ id: head.id, ...narrowing })
    }
    for (const head of narrowed) {
      await tx.execute(
        drizzleSql`UPDATE ${K}.approval_requests
          SET notify_user_ids = ${`{${head.notifyUserIds.join(",")}}`}::uuid[],
              metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ taintAudienceMustHold: head.mustHold })}::jsonb,
              ${proposingTurnScopesUnionSql(taint)}
          WHERE org_id = ${args.orgId}::uuid AND id = ${head.id}::uuid AND status = 'pending'`,
      )
    }
    return { ok: true }
  })
}
