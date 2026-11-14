// SPDX-License-Identifier: FSL-1.1-ALv2

import crypto from "node:crypto"
import {
  agentNoticeCode,
  agentNoticeStoredText,
  type ClientSurface,
  classifyProviderError,
  getReasoningCapability,
  OUT_OF_CREDITS_CODE,
  PAYMENT_REQUIRED_CODE,
  type ProviderNoticeCode,
  redactSecretShapes,
} from "@liaison/shared"
import type { LanguageModel, StopCondition, ToolSet } from "ai"
import {
  APICallError,
  InvalidToolInputError,
  isStepCount,
  NoSuchToolError,
  RetryError,
  streamText,
} from "ai"
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { PrivilegedDb, RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import {
  type AgentTurnOrigin,
  type AgentTurnRestrictions,
  type AgentTurnResumeInput,
  type AgentTurnRow,
  messages,
  routines,
  threadParticipants,
  threads,
} from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { INSTANCE_ID } from "~/infra/instance-id"
import { nextJobTurnOriginRef } from "~/infra/jobs/job-origin"
import { isTestEnv } from "~/lib/env"
import { envFlag } from "~/lib/env-boolean"
import {
  classifyFailure,
  type ExpectedFailureReason,
  type FailureLogger,
  isTimeoutFailure,
} from "~/lib/failure-severity"
import { rootLogger } from "~/lib/logger"
import {
  advanceCheckpoint,
  checkpointAsHistoryRow,
  historyBudget,
  loadBoundedHistory,
} from "~/modules/agent/context/checkpoint"
import {
  COLD_TAIL_TOKEN_BUDGET,
  isColdResume,
  lastAgentTurnCompletedAt,
} from "~/modules/agent/context/cold-resume"
import { estimateTokens, runCompaction } from "~/modules/agent/context/compaction"
import {
  assembleContext,
  estimateToolSchemaTokens,
  personHasNoComputer,
  RUNTIME_TAIL_OPEN,
  stepInputBreakdown,
  TURN_TOOL_SCHEMA_TOKEN_CAP,
  undeliveredGuideBlocks,
} from "~/modules/agent/context/context"
import {
  DISCOVERED_TOOLS_META_KEY,
  loadWindowedDiscoveries,
  recentTools,
  TOOL_ORDER_META_KEY,
} from "~/modules/agent/context/discovery-window"
import {
  GUIDE_NOTES_META_KEY,
  type GuideNote,
  guidePartsInMessages,
  indexedToolPart,
  lastToolResultCallId,
  loadedToolPart,
  noteTokens,
  renderGuideNote,
  renderIndexedToolsBlock,
  renderLoadedToolsBlock,
  skillNotePart,
  storedNotesTokens,
  THREAD_GUIDE_NOTES_TOKEN_CAP,
  withGuideNotes,
} from "~/modules/agent/context/guide-notes"
import { replyLanguage } from "~/modules/agent/context/reply-language"
import {
  checkMidStep,
  finalizeUsage,
  preCheck,
  resolveModelForPreCheck,
  usableDefaultModel,
  visitorStepsPerTurn,
} from "~/modules/agent/credits/credit-meter"
import { recordUnreportedGenerations } from "~/modules/agent/credits/unreported-generations"
import {
  redactMailToolArgs,
  redactMailToolResult,
} from "~/modules/agent/mailbox-plaintext/mail-plaintext-redaction"
import {
  clearEphemeralMailboxContext,
  getEphemeralMailboxContext,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-context"
import { armQuietClose } from "~/modules/agent/memory/consolidation"
import { autoRecall } from "~/modules/agent/memory/memory-recall"
import {
  stepContextInputTokens,
  withAnswerAfterTools,
} from "~/modules/agent/providers/answer-after-tools"
import {
  CALL_TOOL_SDK_NAME,
  type FixedToolList,
  fixedToolListFrame,
  undeliveredLoadedTools,
  withFixedToolList,
} from "~/modules/agent/providers/fixed-tool-list"
import {
  defaultHostSpeedSource,
  stepTokensPerSecond,
} from "~/modules/agent/providers/openrouter-host-speed"
import { resolveModelFromCredit } from "~/modules/agent/providers/provider"
import {
  type AgentProviderOptions,
  buildReasoning,
  type ReasoningLevel,
  resolveTurnReasoningLevel,
} from "~/modules/agent/providers/reasoning"
import { type StepTokenCap, withStepTokenCap } from "~/modules/agent/providers/step-token-cap"
import {
  addProviderCostUsd,
  readProviderCostUsd,
  readStepUsage,
  readUpstreamProvider,
  uncachedInputTokens,
} from "~/modules/agent/providers/step-usage"
import { withStoredKeyOrder } from "~/modules/agent/providers/stored-key-order"
import { withTextToolCalls } from "~/modules/agent/providers/text-tool-calls"
import { trackTurn } from "~/modules/agent/runtime/active-turns"
import {
  ANNOUNCED_ACTION_NOTE,
  announcesImminentAction,
  claimsFreshAction,
} from "~/modules/agent/runtime/announced-action-claim"
import {
  appsNamedInClaim,
  cardClaimsBacked,
  claimedCards,
  claimsConnectedNow,
  FALSE_CARD_NOTE,
  FALSE_CONNECTED_NOTE,
} from "~/modules/agent/runtime/card-claim"
import { FALSE_APPROVAL_NOTE } from "~/modules/agent/runtime/false-approval-claim"
import {
  assessFalseApprovalClaim,
  containsParkedApproval,
  containsSecretRequest,
  containsShownCard,
  FALSE_APPROVAL_CORRECTION_MAX_STEPS,
  falseApprovalLookups,
  preCallTextContradicted,
  type Retraction,
  retractTurnOutput,
  withFalseApprovalGuard,
} from "~/modules/agent/runtime/false-approval-guard"
import { resolveEffectiveAgentModel } from "~/modules/agent/runtime/model-override"
import { connectionClaimVerdict } from "~/modules/agent/runtime/open-cards"
import { persistAgentTurn } from "~/modules/agent/runtime/persist-agent-turn"
import { failureContextRequiredScopes } from "~/modules/agent/runtime/reinvoke"
import { createReplyText, joinStepText, joinStepTexts } from "~/modules/agent/runtime/reply-flatten"
import { clipAndMarkStepMessages } from "~/modules/agent/runtime/rolling-cache-breakpoints"
import {
  currentRunContext,
  inheritedRunFields,
  type RunContext,
  type TurnRecordHandle,
} from "~/modules/agent/runtime/run-context"
import {
  hardLimitNoCallModel,
  hardTokenLimitReached,
  hardTokenLimitStopText,
  recordStepTokens,
  refreshTokenAccount,
  stepTokens,
} from "~/modules/agent/runtime/run-token-limit"
import {
  historyUsedNotificationTools,
  NOTIFICATION_CHANGE_NOTE,
} from "~/modules/agent/runtime/settings-change-note"
import { createLiveTextGate, replyForAudience } from "~/modules/agent/runtime/shared-thread-reply"
import type { ClipLedger } from "~/modules/agent/runtime/stale-result-clipper"
import { StepTimer } from "~/modules/agent/runtime/step-timing"
import {
  markAgentStreamStepBoundary,
  type RecordedFrame,
  recordAgentStreamEvent,
  recordAgentTurnAccepted,
} from "~/modules/agent/runtime/stream-registry"
import {
  earlierSupersededRequest,
  SUPERSEDED_FINISH_REASON,
  SUPERSEDED_TURN_TEXT,
  supersededEarlierWorkNote,
  supersededTurnContent,
  turnSupersededByNewerMessage,
  waitForEarlierLiveTurn,
} from "~/modules/agent/runtime/superseded-turn"
import {
  markSupersededWithinTurn,
  supersedeOlderToolCards,
  type ToolCallPresentation,
  type ToolCardFields,
  toolCallPresentation,
  toolCardFieldsForError,
  toolCardFieldsForResult,
  withToolCardFieldsOnSteps,
} from "~/modules/agent/runtime/tool-card-store"
import { TurnEffectKeys } from "~/modules/agent/runtime/tool-effect-key"
import {
  createTurnDeadline,
  TURN_PROGRESS_CEILING_MS,
  type TurnDeadline,
} from "~/modules/agent/runtime/turn-deadline"
import {
  appOfSdkToolName,
  focusAppNames,
  focusCorePreload,
  focusHeadroomFill,
  resolveTurnFocus,
  withFocusCore,
} from "~/modules/agent/runtime/turn-focus"
import { registerDurableTurn } from "~/modules/agent/runtime/turn-handoff"
import {
  checkInFacts,
  createTurnInputBudget,
  TURN_BUDGET_ANSWER_ONLY_RESULT,
  TURN_BUDGET_CHECK_IN_NOTE,
  TURN_BUDGET_LAST_TOOL_STEP_NOTE,
} from "~/modules/agent/runtime/turn-input-budget"
import {
  type JournalPrepState,
  type JournalStep,
  type JournalStepView,
  journalPayload,
  redactStepMessages,
  stepView,
} from "~/modules/agent/runtime/turn-journal"
import {
  appendStep,
  findByOriginRef,
  finishTurn,
  openTurn,
  reopenForRetry,
  setTurnReply,
  touch as touchTurn,
} from "~/modules/agent/runtime/turn-ledger"
import { planTurnToolBudget } from "~/modules/agent/runtime/turn-tool-budget"
import {
  computeEffectiveScopeForTurn,
  effectiveScopeDm,
  withheldByRoom,
  withheldCapabilities,
} from "~/modules/agent/scopes/effective-scope"
import { beginLiveRun, threadRunKey } from "~/modules/agent/scopes/live-runs"
import { markTurnIfReplaysOutsideText } from "~/modules/agent/scopes/replayed-outside-text"
import { clearTaintFlag } from "~/modules/agent/scopes/taint"
import { projectTaintScopesForOrg } from "~/modules/agent/scopes/taint-read-scopes"
import { redactToolIdentifiers } from "~/modules/agent/scopes/tool-identifier-redaction"
import {
  createTurnScopeAccumulator,
  type TurnScopeAccumulator,
} from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  buildWithheldMessageMetadata,
  describeWithheldCapabilities,
} from "~/modules/agent/scopes/withheld-capability"
import {
  appsCalledInSteps,
  renderMidTurnSkills,
  takeMidTurnSkills,
} from "~/modules/agent/skills/mid-turn-skills"
import { clamp, intersectScopes, isScopeSubset } from "~/modules/agent/subruns/spawn-agent"
import { resultHintsShownIn } from "~/modules/agent/tools/kernel-result-hints"
import { uiEffectRequester } from "~/modules/agent/tools/open-targets"
import {
  ALL_DEFERRED_TOOLS_UNLOCKED,
  admitLateTools,
  buildToolSet,
  isParkedForApproval,
  listDeferredTools,
  moveToolsToEnd,
  orderStartingToolsFirst,
  type StepContext,
} from "~/modules/agent/tools/tool-bridge"
import {
  isUnresolvedToolCallError,
  repairHeldToolCall,
} from "~/modules/agent/tools/tool-name-resolve"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { primeOrgApps } from "~/modules/apps/org-apps"
import { PaymentRequiredError } from "~/modules/cloud/suspension"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { isVisitorDemoOrgId, loadDemoOrg } from "~/modules/demo/demo-org"
import { type DemoSpendCode, DemoSpendHttpError, demoSpendMessage } from "~/modules/demo/demo-spend"
import { serverT } from "~/modules/i18n/server-i18n"
import { assertOrgStartsTurns } from "~/modules/org/transfer-state/gate"
import { beginOrgActivity } from "~/modules/org/transfer-state/state"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { listBlockingNonDisclosableScopes } from "~/modules/permissions/scope-disclosure-policy"
import { sendMessage } from "~/modules/threads/message"
import { ShareAnywayError } from "~/services/security/disclosure-list"

const log = rootLogger.child({ module: "agent-service" })

// Foreground chat defaults. 60s proved too tight for real tool-heavy turns
// (a staging analytics run with 8 live Shopify/invoicing calls was aborted
// mid-loop at exactly 60s and persisted a blank reply), and 180s/25 steps
// still cut off a real per-SKU ASP analysis at 24 tool calls with no final
// answer. Routines and subruns pass their own clamped budget, so widening
// these only affects interactive chat.
const STEP_LIMIT = 40

/**
 * The step a routine run takes after it parked a gated call: tools off, one
 * line on what the run waits for. The run resumes with the decided result
 * (routine-run-resume.ts), and the report waits for the real end.
 */
/** A runner that lost its turn just before writing the reply (S10): nothing is written. */
class TurnFencedAtPersist extends Error {
  constructor() {
    super("turn fenced at persist")
    this.name = "TurnFencedAtPersist"
  }
}

type FinalizeInput = Parameters<RunAgentChatResult["finalize"]>[0]

/**
 * A resumed turn's finalize input: the earlier attempts' complete steps come
 * first (their text, reasoning, timeline, tool calls and usage), then this
 * attempt's, so the one reply the turn writes is the whole turn.
 */
export function withPriorSteps(
  input: FinalizeInput,
  prior: readonly JournalStepView[],
): FinalizeInput {
  if (prior.length === 0) return input
  const sum = (pick: (v: JournalStepView) => number) => prior.reduce((n, v) => n + pick(v), 0)
  const priorText = joinStepTexts(prior.map((v) => v.text))
  const priorReasoning = prior.map((v) => v.reasoning).join("")
  // A retraction is measured on this attempt's streamed text, so it is cut from
  // this attempt's output before the merge (`retractedAttempt`); nothing is cut
  // after it. The merged reply carries no stepTexts: they would count from the
  // attempt's start, not the turn's.
  const { stepTexts: _thisAttempt, ...rest } = input
  return {
    ...rest,
    text: joinStepText(priorText, input.text),
    ...(input.reasoning !== undefined || priorReasoning
      ? { reasoning: priorReasoning + (input.reasoning ?? "") }
      : {}),
    timeline: [...prior.flatMap((v) => v.timeline), ...(input.timeline ?? [])],
    steps: [
      ...prior.map((v) => ({
        ...(v.toolCalls.length ? { toolCalls: v.toolCalls } : {}),
        ...(v.toolResults.length ? { toolResults: v.toolResults } : {}),
        ...(v.toolErrors.length ? { toolErrors: v.toolErrors } : {}),
      })),
      ...input.steps,
    ],
    usage: {
      ...input.usage,
      promptTokens: input.usage.promptTokens + sum((v) => v.usage.inputTokens),
      completionTokens: input.usage.completionTokens + sum((v) => v.usage.outputTokens),
      reasoningTokens: (input.usage.reasoningTokens ?? 0) + sum((v) => v.usage.reasoningTokens),
    },
  }
}

/**
 * An attempt's output without its retracted false text, cut on the very text
 * the retractions were measured on: this attempt's own streamed text, before a
 * resumed turn joins the earlier attempts' steps in front of it
 * (`withPriorSteps`). The later cut first, so the earlier one's offsets hold.
 */
export function retractedAttempt<T extends FinalizeInput>(
  input: T,
  retractions: { first: Retraction | null; second: Retraction | null },
): T {
  const cut = (out: T, r: Retraction | null): T =>
    r ? { ...out, ...retractTurnOutput(out, r) } : out
  return cut(cut(input, retractions.second), retractions.first)
}

/**
 * A resume that cannot run with the restrictions its turn started under
 * (S10, H1/M6): the acting agent is gone or another one would answer, or the
 * model the journal was written for is gone. The resume ends the turn
 * `failed` with `code`; nothing runs wider or on another model.
 */
export class TurnResumeRefused extends Error {
  readonly code: string
  constructor(code: string) {
    super(`turn resume refused: ${code}`)
    this.name = "TurnResumeRefused"
    this.code = code
  }
}

/** The abort reason of a turn whose record another process now owns (S10). */
export const FENCED_REASON = "fenced"
/** The abort reason of a turn a draining process hands off (S10, M2). */
export const DRAIN_HANDOFF_REASON = "drain-handoff"
/** The finish reason of a turn handed off instead of finished: no reply, no "done" frame. */
export const HANDOFF_FINISH_REASON = "handoff"

export const ROUTINE_RUN_PAUSE_NOTE =
  '<runtime-context note="injected by the Liaison platform">This routine run is now paused: it waits for the approval request(s) you just made and resumes, in this same run, with their real result once a person decides them. In one or two short sentences, say what you did so far and what the run waits for. Do not guess the result, do not write a final summary, and do not call any tool.</runtime-context>'

/** What a tool call in a routine run's pause step gets back: it was not run. */
export const ROUTINE_RUN_PAUSE_ANSWER_ONLY_RESULT =
  "This call was not run: this routine run is paused until a person decides the approval request(s) you made. In one or two short sentences, say what you did so far and what the run waits for."

/**
 * What a call gets back while a routine run chains on a parked call, unless it
 * parks for a decision or cites a token (`chainStepAdmits`): it was not run.
 */
export const ROUTINE_CHAIN_ONLY_RESULT =
  "This call was not run: this routine run is proposing the steps of its approval request. Only a call that waits for approval, or one that cites a token from `outputs`, may run now. Propose the next step, or stop."

type StepToolResult = { toolName?: string; output?: unknown; result?: unknown }

function stepToolResults(step: unknown): StepToolResult[] {
  const results = (step as { toolResults?: StepToolResult[] })?.toolResults
  return Array.isArray(results) ? results : []
}

/**
 * A call parked for a human decision: the kernel's blocked envelope
 * (`isParkedForApproval`), or a conditionally gated tool that parked itself
 * (`{ status: "pending_approval", approval_id }`, `withHandlerApprovalGuidance`).
 */
function parkedResult(r: StepToolResult): { outputs?: unknown } | null {
  const out = r?.output ?? r?.result
  if (isParkedForApproval(out)) return out as { outputs?: unknown }
  const d = out as { status?: unknown; approval_id?: unknown } | null | undefined
  return d && d.status === "pending_approval" && typeof d.approval_id === "string"
    ? (d as { outputs?: unknown })
    : null
}

/** Whether an agent step parked a call for a human decision. */
function stepParkedACall(step: unknown): boolean {
  return stepToolResults(step).some((r) => parkedResult(r) !== null)
}

/**
 * Whether a parked call of this step handed out @ref tokens (`outputs`): a
 * later call may cite them, so the run can still propose its next step now.
 */
function stepParkedWithOutputs(step: unknown): boolean {
  return stepToolResults(step).some((r) => {
    const outputs = parkedResult(r)?.outputs
    return outputs !== null && typeof outputs === "object" && Object.keys(outputs).length > 0
  })
}

const TOOL_SEARCH_NAME = /(^|__)tool_search$/

/** A call the tools refused (`{ error }`): it changed nothing, and its error says how to fix it. */
function refusedResult(r: StepToolResult): boolean {
  const out = (r?.output ?? r?.result) as { error?: unknown; status?: unknown } | null | undefined
  if (!out || typeof out !== "object" || out.error === undefined || out.error === null) return false
  return out.status === undefined || out.status === "error"
}

/**
 * Whether a step only looked tools up (tool_search) or had its calls refused: it
 * proposes nothing, changes nothing and reads no data.
 */
function stepOnlyDiscoveredOrRefused(step: unknown): boolean {
  const results = stepToolResults(step)
  return (
    results.length > 0 &&
    results.every((r) => TOOL_SEARCH_NAME.test(String(r?.toolName ?? "")) || refusedResult(r))
  )
}

/** Refused steps a chaining run may retry before it pauses all the same. */
export const ROUTINE_CHAIN_RETRIES = 3

/**
 * When a routine run's pause falls due (see `routinePauseDue`). A parked call
 * that hands out @ref tokens lets the run go on proposing the calls that cite
 * them (one request the person approves once); the pause falls due at the
 * first step that parks a call with nothing to chain on, or that does anything
 * but look a tool up or have a call refused (its error says how to fix it, up
 * to `ROUTINE_CHAIN_RETRIES` times) after a call was parked.
 */
export function routinePauseFallsDue(
  step: unknown,
  parkedEarlier: boolean,
  retriesLeft = ROUTINE_CHAIN_RETRIES,
): boolean {
  if (stepParkedACall(step)) return !stepParkedWithOutputs(step)
  return parkedEarlier && (retriesLeft <= 0 || !stepOnlyDiscoveredOrRefused(step))
}

const TIMEOUT_MS = 300_000

// A foreground turn with no budget of its own runs on a PROGRESS deadline
// (turn-deadline.ts): stopped when one step makes no progress for TIMEOUT_MS,
// or at the absolute ceiling. A test shortens both.
let defaultTurnDeadline = { stepMs: TIMEOUT_MS, ceilingMs: TURN_PROGRESS_CEILING_MS }

/** Per-invocation agent budget. Both fields optional — an absent field keeps
 *  today's default (STEP_LIMIT / TIMEOUT_MS). Clamped to KERNEL_FLOORS/CEILINGS
 *  by {@link resolveAgentBudget} so a buggy/hostile caller can never request an
 *  unbounded run nor a zero-step deadlock. */
type MidTurnSteps = Parameters<typeof appsCalledInSteps>[0]

export interface AgentBudget {
  maxSteps?: number
  timeoutMs?: number
}

/** Resolve a per-invocation budget to concrete `{ maxSteps, timeoutMs }`,
 *  clamped via the shared spawn-agent clamp against KERNEL_FLOORS/DEFAULTS/
 *  CEILINGS. Passing STEP_LIMIT/TIMEOUT_MS as the clamp `defaultVal` makes an
 *  absent field default to today's foreground values — so existing callers
 *  (no budget) are byte-identical. */
export function resolveAgentBudget(budget?: AgentBudget): { maxSteps: number; timeoutMs: number } {
  return {
    maxSteps: clamp(budget?.maxSteps, STEP_LIMIT, "maxSteps"),
    timeoutMs: clamp(budget?.timeoutMs, TIMEOUT_MS, "timeoutMs"),
  }
}
let streamTextForAgent = streamText

// Cross-process test seam — `AgentServiceTestAccess.setStreamText` only swaps the
// module-level variable in the current process. For e2e scenarios that
// spawn a server subprocess (setupScenario / createWorkerEnv), the
// in-test stub is invisible. To make a stub reachable from the spawned
// server, the test passes `serverEnv: { AGENT_STREAM_STUB: <path> }`;
// the server then dynamically imports the bundle at module load and uses
// its default export as `streamTextForAgent`. The path must resolve from
// the server's cwd (apps/api), so callers usually pass an absolute path.
// Without this hook, LLM-driven scenarios like agent-tickets S7 flake on
// real-model nondeterminism (Haiku occasionally skips the requested
// tool call under parallel load).
if (isTestEnv() && process.env.AGENT_STREAM_STUB) {
  const stubPath = process.env.AGENT_STREAM_STUB
  // Use an immediately-invoked async load so the module hot-path remains
  // sync — the spawned server's first /api/agent/chat will await app
  // initialization (via ensureAppsForOrg) so the stub is guaranteed to
  // be loaded by the time streamTextForAgent is called.
  ;(async () => {
    try {
      const mod = await import(stubPath)
      const fn = mod.default ?? mod.streamTextStub
      if (typeof fn === "function") streamTextForAgent = fn
      else log.warn({ stubPath }, "AGENT_STREAM_STUB module has no default export")
    } catch (err) {
      log.error({ err, stubPath }, "Failed to load AGENT_STREAM_STUB module")
    }
  })()
}

/**
 * Lower-level streaming primitive — drives the AI SDK `streamText` call with
 * the canonical agent loop (stopWhen + onStepFinish credit check). Shared
 * between `runAgentChat` (canonical chat agent) and the subrun worker
 * (per-record sub-agent dispatch).
 *
 * This is intentionally thin: callers assemble `system`, `messages`, `tools`
 * themselves. The function does not touch DB, audit, or message persistence
 * — only the model-side loop. Termination is via `stopWhen` and
 * `abortSignal`.
 *
 * Test seam: `AgentServiceTestAccess.setStreamText()` is honored here, so all existing
 * test stubs continue to apply.
 */
export interface RunAgentStreamParams {
  model: LanguageModel
  /**
   * The thread's fixed tool list (providers/fixed-tool-list.ts): the provider
   * is shown only these tools, and a loaded tool outside them is called
   * through kernel__call_tool. Absent or null: every active tool is sent.
   */
  fixedToolList?: FixedToolList
  /** Either a flat string or the structured `SystemPart[]` produced by `assembleContext`. */
  system: string | Array<unknown>
  messages: Array<{ role: string; content: unknown }>
  tools: ToolSet
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>
  onStepFinish?: (step: unknown) => void | Promise<void>
  abortSignal?: AbortSignal
  /**
   * Per-step hook forwarded to `streamText`. The chat agent returns
   * `{ activeTools }` from it so only core + discovered tool SCHEMAS reach the
   * provider each step, while the full `tools` set stays executable (deferred
   * tools unlocked mid-run by tool_search are callable on the next step).
   */
  prepareStep?: (options: unknown) =>
    | {
        activeTools?: string[]
        toolChoice?: "none" | "required"
        system?: unknown
        messages?: unknown
      }
    | undefined
  /**
   * The output limit of each request (`ModelInfo.stepTokenCap`): set for the
   * demo orgs on the box's key, whose budgets are priced on it, null for every
   * other org. Required, not optional, so a caller cannot run such a turn
   * uncapped by leaving it out (providers/step-token-cap.ts).
   */
  stepTokenCap: StepTokenCap | null
  /** Times each step's model call (time to first token, model time), step-timing.ts. */
  stepTimer?: StepTimer
  /**
   * Per-provider reasoning/thinking options (from `buildReasoning`). Forwarded
   * verbatim to `streamText` so every caller of the shared loop — chat,
   * shared-thread agents, sub-runs — can request reasoning the same way.
   */
  providerOptions?: AgentProviderOptions
  /**
   * SDK retry budget for each model call. The AI SDK default (2 retries,
   * exponential from 2s) dies inside a per-MINUTE token-rate window: Gemini's
   * TPM quota answers "retry in ~25-45s" and three fast attempts all land in
   * the same window. Background work (routine ticks, sub-runs) passes
   * BACKGROUND_MAX_RETRIES so the backoff ladder rides out a full quota
   * window instead of failing the tick; interactive chat keeps the snappy
   * default.
   */
  maxRetries?: number
  /**
   * The SDK's tool-call repair hook. The chat loop passes `blindCallRepair`
   * so a call to a tool the provider was not shown becomes its discovery.
   */
  repairToolCall?: (options: {
    toolCall: { toolCallId: string; toolName: string; input: string }
    error: unknown
  }) => Promise<{ type: "tool-call"; toolCallId: string; toolName: string; input: string } | null>
}

/**
 * A BLIND CALL IS A DISCOVERY, at the SDK seam. `activeTools` gates what the
 * provider is shown, and a weak model still calls tools it knows by name from
 * the deferred catalog. The SDK parses every call against the ACTIVE set, so
 * such a call never reached the bridge: it came back as "Model tried to call
 * unavailable tool" with the whole active list in the error, one wasted step,
 * and the model had to guess that tool_search was the way in. The repair hook
 * rewrites the call, in the same step, into `tool_search select:<name>`, which
 * loads the schema and the app's guide section for the next step. A name in
 * another separator form (`app:tool`, bare `tool`) is mapped onto the held
 * tool it names first; see `repairHeldToolCall`.
 */
export function blindCallRepair(
  tools: ToolSet,
): NonNullable<RunAgentStreamParams["repairToolCall"]> {
  return repairHeldToolCall(tools)
}

/** A message of a turn's runtime tail (the ephemeral per-turn context, never replayed). */
function isRuntimeTailMessage(m: { role: string; content: unknown } | undefined): boolean {
  return (
    m?.role === "user" && typeof m.content === "string" && m.content.startsWith(RUNTIME_TAIL_OPEN)
  )
}

/**
 * A call to a loaded tool OUTSIDE the thread's fixed tool list whose input
 * does not fit the tool goes to kernel__call_tool, whose answer names the tool
 * and shows its parameters (call-tool.ts): the SDK's own error says only what
 * failed, and the model has the schema from a note, not from its tool list.
 * Every other call is repaired by `base` as before.
 */
export function fixedToolListRepair(
  base: NonNullable<RunAgentStreamParams["repairToolCall"]>,
  listed: FixedToolList,
): NonNullable<RunAgentStreamParams["repairToolCall"]> {
  if (listed === null) return base
  return async (options) => {
    const repaired = await base(options)
    if (repaired) return repaired
    const { toolCall, error } = options
    if (!InvalidToolInputError.isInstance(error)) return null
    if (toolCall.toolName === CALL_TOOL_SDK_NAME || listed.has(toolCall.toolName)) return null
    let args: unknown = {}
    try {
      args = JSON.parse(toolCall.input)
    } catch {
      // Not JSON at all: kernel__call_tool reports the missing arguments.
    }
    return {
      type: "tool-call",
      toolCallId: toolCall.toolCallId,
      toolName: CALL_TOOL_SDK_NAME,
      input: JSON.stringify({
        name: toolCall.toolName,
        arguments: typeof args === "object" && args !== null && !Array.isArray(args) ? args : {},
      }),
    }
  }
}

/**
 * The level a `tool-error` chunk is logged at. A call to a tool the model does
 * not hold, or with input that fails the tool's schema, is the MODEL's mistake:
 * the SDK hands the error back to it in the same turn and it corrects course,
 * like any agent-correctable 4xx, so it is a warn. Anything else reached the
 * chunk by escaping the tool bridge and stays an error.
 */
export function toolErrorLogLevel(error: unknown): "warn" | "error" {
  if (NoSuchToolError.isInstance(error) || InvalidToolInputError.isInstance(error)) return "warn"
  // The stream's tool-error chunk carries the SDK's flattened message string.
  if (isUnresolvedToolCallError(error)) return "warn"
  return "error"
}

/** 2+4+8+16+32+64+128s of exponential backoff — spans two TPM windows. */
export const BACKGROUND_MAX_RETRIES = 7

// Hard per-run ceiling on UNCACHED input tokens (inputTokens minus the
// provider-reported cache hits). Uncached tokens are what the provider bill
// actually scales with — a cache-friendly run re-reading a stable prefix pays
// ~¼ rate on hits, so counting raw tokens would punish exactly the
// cache-discipline the loop is built around, while a genuine runaway
// (cache-hostile retry storms, prefix busts) burns uncached tokens fast and
// still trips this quickly. Above this line the run is BY DEFINITION a bug:
// abort it, persist the truthful stop cause, and error-log so the watchdog
// pages — the spend surfaces as an incident, not a provider bill.
// Sized from a measured healthy worst case: a full warranty-RMA tick (video
// analysis, 4 skills, investigation, the 4-step one-approval label chain)
// completes at ~740k uncached; 1.5M leaves headroom for genuinely complex
// tickets while still tripping fast on pathology.
export const AGENT_RUN_INPUT_TOKEN_CAP = 1_500_000
// Early-warning threshold: warn-log once per run at half the cap so runs that
// legitimately trend heavy show up in the daily digest before they ever page.
export const AGENT_RUN_INPUT_TOKEN_WARN = AGENT_RUN_INPUT_TOKEN_CAP / 2

/**
 * Pure decision for the per-step runaway guard: what to do after a step brings
 * the run's CUMULATIVE input tokens to `cumulativeInputTokens`. Exported so the
 * threshold policy is unit-testable without booting a model stream.
 */
export function runawayGuardDecision(
  cumulativeInputTokens: number,
  warnAlreadyLogged: boolean,
): "abort" | "warn" | "none" {
  if (cumulativeInputTokens > AGENT_RUN_INPUT_TOKEN_CAP) return "abort"
  if (!warnAlreadyLogged && cumulativeInputTokens > AGENT_RUN_INPUT_TOKEN_WARN) return "warn"
  return "none"
}

/**
 * The requiredScopes an ENDING turn's writes carry (spec-security.md A2).
 *
 * Every turn, clean or abnormal, is tagged with what its tool calls and
 * injected context accumulated (`accumulator.snapshot()`, already projected
 * onto read scopes with grant wildcards expanded, scope-taint.ts rules 5 and
 * 10b). The accumulator is the faithful record of what the turn read: the tool
 * bridge records each call's scopes BEFORE the tool runs, so a call that threw,
 * timed out or was cancelled mid-flight is in it, and so is every stamp read as
 * history. An empty snapshot is the positive assertion that the turn touched
 * nothing scoped.
 *
 * 2026-11-03, owner decision: a turn that ended abnormally after a tool call
 * used to be widened to the agent's whole effective scope (its ceiling). On a
 * `*` ceiling that stamped `*` and the whole ceiling on any turn that ended
 * without text; the stamp was re-read as history by every later turn, so the
 * conversation's taint grew to the ceiling and replies were hidden from
 * teammates who could read everything the turn had actually touched.
 *
 * The ceiling is only the FALLBACK when no record survived (`accumulator`
 * undefined): nothing then knows what ran, so the turn is tagged with the
 * agent's effective scope when the frame has one, else (no live agent acted,
 * the turn ran at the actor's scopes alone) the requester's own scopes, the
 * answer FX1 gave the reinvoke failure context. That fallback is projected
 * onto read scopes and its wildcards expanded (`projectTaintScopesForOrg`), so
 * it never stamps a write scope or `*`. An effective scope that is present and
 * EMPTY is used as given: a turn floored to nothing provably read nothing.
 */
export function turnEndRequiredScopes(input: {
  accumulator?: TurnScopeAccumulator
  fullEffectiveScope?: string[]
  requesterScopes: string[]
  orgId?: string
}): string[] {
  const { accumulator, fullEffectiveScope, requesterScopes } = input
  if (accumulator !== undefined) return accumulator.snapshot()
  return projectTaintScopesForOrg(
    fullEffectiveScope ?? failureContextRequiredScopes(requesterScopes),
    input.orgId,
  )
}

/** Is this turn a demo visitor's (box key or the visitor's own key)? */
async function isVisitorTurn(orgId: string, onBoxKey: boolean): Promise<boolean> {
  if (onBoxKey) return true
  if (!isDemoModeEnabled()) return false
  return isVisitorDemoOrgId(orgId)
}

type ProviderErrorShape = {
  name?: unknown
  message?: unknown
  statusCode?: unknown
  isRetryable?: unknown
  code?: unknown
  cause?: unknown
  url?: unknown
}

function asErrorShape(error: unknown): ProviderErrorShape {
  return typeof error === "object" && error !== null ? (error as ProviderErrorShape) : {}
}

/**
 * The error that says what happened. An AI_RetryError (every retry spent, or a
 * non-retryable error after a retry) carries no status of its own: its
 * `lastError` does.
 */
function innermostProviderError(error: unknown): unknown {
  return RetryError.isInstance(error) && error.lastError !== undefined ? error.lastError : error
}

/** What one provider stream error says, as flat fields for one JSON log line. */
export function providerStreamErrorFields(
  error: unknown,
  model: LanguageModel,
): Record<string, unknown> {
  const outer = asErrorShape(error)
  const e = asErrorShape(innermostProviderError(error))
  const message = typeof outer.message === "string" ? outer.message : String(error)
  const cause = e.cause as
    | { name?: unknown; message?: unknown; code?: unknown }
    | string
    | undefined
  let host: string | undefined
  if (typeof e.url === "string") {
    try {
      host = new URL(e.url).host
    } catch {
      host = undefined
    }
  }
  return {
    provider: typeof model === "string" ? undefined : model.provider,
    modelId: typeof model === "string" ? model : model.modelId,
    errorName: typeof outer.name === "string" ? outer.name : typeof error,
    // First line only: the AI SDK's own print carried a code frame, the request
    // body and the headers, one watchdog signature per line.
    message: redactSecretShapes(message.split("\n")[0] ?? "").slice(0, 300),
    ...(RetryError.isInstance(error)
      ? {
          retryReason: error.reason,
          attempts: error.errors.length,
          ...(typeof e.name === "string" ? { lastErrorName: e.name } : {}),
        }
      : {}),
    ...(typeof e.statusCode === "number" ? { statusCode: e.statusCode } : {}),
    ...(typeof e.code === "string" ? { code: e.code } : {}),
    ...(typeof e.isRetryable === "boolean" ? { retryable: e.isRetryable } : {}),
    ...(typeof cause === "string"
      ? { cause }
      : cause && typeof cause === "object"
        ? {
            cause: [cause.name, cause.code, cause.message]
              .filter((v) => typeof v === "string" && v !== "")
              .join(": ")
              .slice(0, 200),
          }
        : {}),
    ...(host ? { host } : {}),
  }
}

/**
 * Why a provider stream error is an upstream outcome (warn), or undefined when it
 * is ours to fix (error). Read on the innermost error (a RetryError's last one).
 * - the caller went away, or the call was aborted: its abort reason;
 * - 429: rate_limited;
 * - a timeout (the turn's own deadline aborting a slow read, a socket timeout),
 *   or a 2xx response whose body failed to arrive ("Failed to process successful
 *   response", which the SDK marks not retryable): upstream_unavailable;
 * - any other failure the SDK marks retryable (408, 409, 5xx): upstream_unavailable.
 * A provider refusing the request we built (a non-retryable 4xx) and anything
 * unclassified stay at error.
 */
export function providerStreamFailureReason(error: unknown): ExpectedFailureReason | undefined {
  const inner = innermostProviderError(error)
  const classified = classifyFailure({ err: inner })
  if (classified.reason === "caller_cancelled" || classified.reason === "aborted") {
    return classified.reason
  }
  const e = asErrorShape(inner)
  const status = typeof e.statusCode === "number" ? e.statusCode : undefined
  if (status === 429) return "rate_limited"
  if (classified.reason === "timeout" || isTimeoutFailure(e.cause)) return "upstream_unavailable"
  if (APICallError.isInstance(inner) && status !== undefined && status >= 200 && status < 300) {
    return "upstream_unavailable"
  }
  if (e.isRetryable === true) return "upstream_unavailable"
  return undefined
}

/**
 * The stream's `onError`: one structured line instead of the AI SDK default
 * (`console.error(error)`, a multi-line plain-text dump). It only logs: the
 * error still flows through the stream, so the turn ends with its visible
 * failure exactly as before. An upstream outcome logs at warn with its reason
 * (`providerStreamFailureReason`); anything else (a request the provider
 * refused as malformed) is ours to fix: error.
 */
export function logProviderStreamError(
  error: unknown,
  model: LanguageModel,
  logger: FailureLogger = log,
  signal?: AbortSignal,
): void {
  const fields = providerStreamErrorFields(error, model)
  // The turn's own stop (its deadline, the person's stop, a drain) aborts the
  // call it was in: the error is that stop, not the provider's, and says so.
  if (signal?.aborted) {
    logger.warn(
      { ...fields, reason: "aborted", turnStop: String(signal.reason) },
      "Agent stream error",
    )
    return
  }
  const reason = providerStreamFailureReason(error)
  if (reason) logger.warn({ ...fields, reason }, "Agent stream error")
  else logger.error(fields, "Agent stream error")
}

/**
 * How many times a turn whose provider failed in the middle of a step is run
 * again from its last complete step (turn-resume.ts) before the failure is
 * the turn's answer. Counted on the turn's attempts.
 */
export const STREAM_FAILURE_RETRIES = 2

/** The wait before the re-run of a turn at `attempt` (0-based): 1 s, then 3 s. */
export function streamFailureRetryDelayMs(attempt: number): number {
  return 1000 * 3 ** Math.max(0, attempt)
}

// A connection the provider dropped while its body streamed: the fetch read
// rejects with one of these (undici's "terminated", a socket reset).
const CONNECTION_DROP_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "ERR_STREAM_PREMATURE_CLOSE",
])
const CONNECTION_DROP_MESSAGE = /\b(terminated|socket hang up|other side closed|premature close)\b/i

function isConnectionDrop(err: unknown, depth = 0): boolean {
  if (depth > 3 || typeof err !== "object" || err === null) return false
  const e = err as { code?: unknown; message?: unknown; cause?: unknown }
  if (typeof e.code === "string" && CONNECTION_DROP_CODES.has(e.code)) return true
  if (typeof e.message === "string" && CONNECTION_DROP_MESSAGE.test(e.message)) return true
  return isConnectionDrop(e.cause, depth + 1)
}

/**
 * Whether a provider failure is the provider having stopped answering (a
 * timeout, a dropped connection, a 2xx whose body failed to arrive, a 5xx),
 * which running the step again can cure, rather than a request it refused.
 * While the turn's own signal is aborted the failure is the turn stopping (its
 * deadline, the person's stop, a drain), never the provider's.
 */
export function isTransientProviderFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false
  if (providerStreamFailureReason(error) === "upstream_unavailable") return true
  return isConnectionDrop(innermostProviderError(error))
}

/**
 * A step hook whose first step must call a tool (`toolChoice: "required"`),
 * unless the wrapped hook already turned tools off for it (the step budget).
 */
export function firstStepCallsATool(
  prepareStep: RunAgentStreamParams["prepareStep"],
): NonNullable<RunAgentStreamParams["prepareStep"]> {
  return (options: unknown) => {
    const base = prepareStep?.(options)
    const stepNumber = (options as { stepNumber?: number } | undefined)?.stepNumber ?? 0
    if (stepNumber !== 0 || base?.toolChoice === "none") return base
    return { ...(base ?? {}), toolChoice: "required" }
  }
}

export function runAgentStream(params: RunAgentStreamParams): ReturnType<typeof streamText> {
  return streamTextForAgent({
    onError: ({ error }: { error: unknown }) =>
      logProviderStreamError(error, params.model, log, params.abortSignal),
    // A tool call the model wrote out as text becomes a real call instead of
    // the turn's answer (see text-tool-calls.ts). Inside it, a step after tool
    // results that says nothing is asked once to answer (answer-after-tools.ts),
    // so a written call in that second answer is still caught.
    // The cap is innermost, so the answer-after-tools re-issue is capped too.
    // Outermost, the thread's fixed tool list: everything inside sees the
    // request the provider gets, and a call through kernel__call_tool comes
    // back out as a call to the tool it names (fixed-tool-list.ts). Around it
    // all, tool calls and results are written in the key order a later turn
    // replays them in (stored-key-order.ts).
    model: withStoredKeyOrder(
      withFixedToolList(
        withTextToolCalls(
          withAnswerAfterTools(withStepTokenCap(params.model, params.stepTokenCap)),
        ),
        params.fixedToolList ?? null,
      ),
    ),
    system: params.system as never,
    messages: params.messages as never,
    tools: params.tools,
    stopWhen: params.stopWhen as never,
    onStepFinish: params.onStepFinish as never,
    // A demo visitor's step is settled as soon as its model call has answered,
    // before its tools run (AI SDK 7 runs them at `model-call-end`, after this
    // callback), so a waiting tool holds no reservation (step-token-cap.ts).
    ...(params.stepTokenCap?.onCallEnd || params.stepTimer
      ? {
          onLanguageModelCallEnd: (event: { usage: unknown; providerMetadata?: unknown }) => {
            params.stepTimer?.callEnd()
            return params.stepTokenCap?.onCallEnd?.(event.usage, event.providerMetadata)
          },
        }
      : {}),
    ...(params.stepTimer
      ? {
          onLanguageModelCallStart: () => params.stepTimer?.callStart(),
          onChunk: () => params.stepTimer?.chunk(),
        }
      : {}),
    abortSignal: params.abortSignal,
    providerOptions: params.providerOptions,
    prepareStep: params.prepareStep as never,
    ...(params.repairToolCall
      ? { experimental_repairToolCall: params.repairToolCall as never }
      : {}),
    ...(params.maxRetries != null ? { maxRetries: params.maxRetries } : {}),
  })
}

let runAgentChatForTest: ((params: any) => Promise<any>) | undefined

export function getRunAgentChat(): (params: any) => Promise<any> {
  return (runAgentChatForTest ?? (runAgentChat as any)) as (params: any) => Promise<any>
}

/**
 * ROUTINE-TICK MODEL/REASONING OVERRIDE (deep-week-sim runtime-execution gate ladder + per-routine pin).
 * A routine TICK (`background:true`) resolves its model/reasoning with this precedence, highest first:
 *   1. The operator escalation ladder env (`LIAISON_CHAOS_AGENT_MODEL` / `LIAISON_CHAOS_REASONING_LEVEL`),
 *      which the chaos agent-stream bridge threads into the CONDUCTOR conversation — scoped to background
 *      ticks AND gated on the env being set, so it is a pure no-op in production (the envs are only ever
 *      set by the chaos runner). Kept top precedence so a chaos run can still force a pinned model even
 *      when a routine or its thread declares its own.
 *   2. The routine's OWN `agentModelId` / `agentReasoningLevel` (set via create_routine / update_routine
 *      or the routine detail UI). This lets a routine be pinned to a model BEFORE its output thread even
 *      exists — the thread is created lazily on first tick, so without this level a routine could never be
 *      configured ahead of its first run.
 *   3. The routine's OUTPUT THREAD setting (`threadModelId` / the thread's per-model reasoning map) — the
 *      pre-existing behavior, still honored when the routine itself has no override.
 *   4. Org auto-select / reasoning "off" (both undefined/null flow through unchanged).
 * The reasoning value is validated against the enum at each level; an unknown value is ignored and falls
 * through to the next level. Pure + deterministic so it is unit-testable without the agent runtime.
 */
export function resolveRoutineTickModelOverride(input: {
  background: boolean
  threadModelId: string | undefined
  threadReasoningLevel: ReasoningLevel | null
  /** The routine's own `agentModelId` column — undefined/null when the routine declares no override. */
  routineModelId?: string | null
  /** The routine's own `agentReasoningLevel` column — undefined/null when the routine declares no override. */
  routineReasoningLevel?: ReasoningLevel | null
  env: Record<string, string | undefined>
}): { modelId: string | undefined; reasoningLevel: ReasoningLevel | null } {
  let modelId = input.threadModelId
  let reasoningLevel = input.threadReasoningLevel
  if (input.routineModelId) modelId = input.routineModelId
  if (
    input.routineReasoningLevel &&
    (["off", "low", "medium", "high"] as const).includes(input.routineReasoningLevel)
  ) {
    reasoningLevel = input.routineReasoningLevel
  }
  if (input.background) {
    const envModel = input.env.LIAISON_CHAOS_AGENT_MODEL
    if (envModel && envModel.trim()) modelId = envModel.trim()
    const envReasoning = input.env.LIAISON_CHAOS_REASONING_LEVEL
    if (
      envReasoning &&
      (["off", "low", "medium", "high"] as const).includes(envReasoning as ReasoningLevel)
    ) {
      reasoningLevel = envReasoning as ReasoningLevel
    }
  }
  return { modelId, reasoningLevel }
}

/**
 * Where the UNSCRUBBED text of a scrubbed coordination answer is kept: on the
 * message metadata, under a key no surface renders. The row a person reads
 * carries the scrub; the audit carries what the agent actually said.
 */
export const COORDINATION_RAW_CONTENT_KEY = "coordinationRawContent"

/**
 * An AGENT started this turn (P3b): who asked, the message the exchange hangs
 * under, and the two things a delegation carries across the hand off.
 */
export interface TurnCoordination {
  /** The agent that asked, or null when a HUMAN caller asked at a stated
   *  ceiling (an MCP connection with no agent binding). Recorded for the
   *  reader of a hand off, never read by the turn itself. */
  callerAgentId: string | null
  parentMessageId: string
  /**
   * A4: the turn's scope is this agent's ceiling intersected with the grants
   * of the person the request originates from (a routine tick: the calling
   * turn's effective scope), computed once by `delegateToAgent` at the hand
   * off and then floored by the room. The callee never runs at its own
   * ceiling alone: that is how a delegation would widen past the person.
   */
  delegatedScope?: string[]
  /**
   * What the CALLER's turn had already read when it asked. Unioned into this
   * turn's accumulator before the first step, so the callee's own writes carry
   * the caller's taint exactly as they would inside one turn.
   */
  callerTaintScopes?: string[]
  /**
   * THE QUESTION THE CALLEE WAS ASKED, and who asked it. The callee's turn is
   * framed on this (see `assembleContext.askedQuestion`): without it the turn
   * had no instruction of its own and answered whatever the thread was about
   * before the question arrived.
   */
  askedQuestion?: { askedBy: string; question: string }
}

interface RunAgentChatParams {
  threadId: string
  content: string
  modelId?: string | null
  /** Requested reasoning level for this turn. Clamped to "off" for models that
   *  don't support reasoning; absent → the model's default. Ignored when Auto
   *  picked the model: that turn runs at High (resolveTurnReasoningLevel). */
  reasoningLevel?: ReasoningLevel | null
  currentView?: { tabType: string; entityId: string }
  actor: UserContext
  orgId: string
  skipUserPersist?: boolean
  userMessageId?: string
  requestSignal?: AbortSignal
  /**
   * True when this chat is driven by background work (a routine tick or a
   * job-driven re-invocation) rather than a live foreground user request. Stamped
   * onto the run's ALS frame so tool dispatch is tagged "background" and cannot
   * starve foreground tool calls. Defaults to false (interactive).
   */
  background?: boolean
  /**
   * Per-invocation step/timeout budget. Absent (the default for every existing
   * caller) → today's STEP_LIMIT / TIMEOUT_MS. The routine supervisor passes a
   * per-turn budget so a long task can run across N bounded turns.
   */
  budget?: AgentBudget
  /**
   * The id of the routine whose TICK is driving this run, when this is a routine tick. Stamped onto
   * the run's ALS frame (`runFrame.routineId`) so `buildToolSet` admits the ROUTINE-ONLY tools
   * (web_watch / watch_state) into the tick's tool set — they are gated on a routine run frame and are
   * (correctly) invisible to interactive chat / sub-runs that have no per-routine state. Absent for every
   * foreground / non-routine caller (web_watch stays unavailable there, as intended).
   */
  routineId?: string
  /**
   * Per-tick discovered-tool set supplied by the routine supervisor (shared by
   * reference across a tick's `length` re-loop turns). When present it REPLACES
   * the thread's persisted discoveries as the seed, so a tick starts from the
   * lean core tool surface instead of inheriting every app any past tick ever
   * unlocked. Absent for interactive chat (thread continuity as before).
   */
  seedDiscoveredTools?: Set<string>
  /** Anchor assembled history at this run's triggering message (see invokeAgentForThread.anchorHistory). */
  anchorHistory?: boolean
  /**
   * The nonce the client minted for THIS turn (blueprint Task 9.2). It is the
   * binding between a turn the user actually started and any request to decrypt
   * their mail: the browser refuses a decrypt request whose nonce does not match
   * a turn it started and still has open. Absent for every non-browser caller,
   * which is exactly why those turns take the locked path.
   */
  mailboxTurnNonce?: string
  /**
   * Where the human who sent this turn's message is: the desktop app, a web
   * browser or the mobile app. It only chooses which steps to computer mode
   * the turn gives (assembleContext). Absent for every caller with no live
   * surface behind it, which the context reads as unknown.
   */
  clientSurface?: ClientSurface
  /**
   * Share anyway: act as `agentId` at exactly `effectiveScope` instead of the
   * scope the room floor would give. Checked against a fresh `ceiling ∩
   * requester grants` and the actor's scopes; an entry outside either, or an
   * agent that is not live in the org, refuses the turn (fail closed).
   */
  scopeOverride?: { agentId: string; effectiveScope: string[] }
  /**
   * The agent this turn was addressed to by an `@mention` (P4b-T16). A channel
   * has many agents in it, so the mention decides which one answers; without it
   * the turn falls back to the requester's own personal agent, which is the
   * right answer for a DM and the wrong one for "@support, look at this".
   * Scope is still computed from that agent's ceiling and the room floor, never
   * handed in.
   */
  actingAgentId?: string
  /**
   * An AGENT started this turn (P3b): who asked, and the message the exchange
   * hangs under. Every message the turn persists takes that same parent, so an
   * agent only exchange nests ONE level under the ask. Absent means a human
   * facing turn, which stays flat at the thread root.
   */
  coordination?: TurnCoordination
  /**
   * Another AGENT started this turn (`agents_ask`, or an agent's message that
   * @mentions this one), so its answer goes back to that agent, not to a
   * person. Such a turn carries no input budget (turn-input-budget.ts): a
   * "should I continue?" would go to a caller that cannot say yes.
   */
  agentDispatched?: boolean
  /**
   * The person started this turn from a restricted (device-flow) session
   * (session-ceiling.ts). Stamped on the run frame, so a tool whose REST
   * counterpart calls `assertUnrestrictedSession` refuses it the same way.
   */
  sessionRestricted?: boolean
  /**
   * The ROOT of the reply thread this turn answers in (0112, A7). Undefined
   * reads it off the triggering message, so every entry point (a mention, an
   * agent chat, an ask, a re-invocation) answers where it was asked. When
   * set, every line the turn writes lands in that reply thread, the history
   * is the root plus its replies (A8), and the channel's checkpoint is
   * neither read nor advanced.
   */
  replyRootId?: string | null
  /**
   * False returns the reply from `finalize` instead of persisting it, and skips
   * every room-visible side effect (typing indicator, compaction, system
   * message, broadcast). Needs `skipUserPersist` with `userMessageId`: the turn
   * answers an existing message, whose history ends the context. Default true.
   */
  persistReply?: boolean
  /**
   * True runs the turn with a READ-ONLY tool catalog: every tool that is not
   * `readOnly` is left out, and one that is called anyway is refused instead of
   * executed. The Share anyway rerun sets it so re-answering a withheld turn
   * cannot repeat the mail it sent or the ticket it opened (spec-security.md
   * D4). Default false: an ordinary turn may write.
   */
  readOnlyTools?: boolean
  /**
   * The person's message this turn ultimately answers (RunContext.askId).
   * Absent means the triggering message itself, which is right for every turn
   * a person's message started. The turn an approved call hands back passes
   * the ask of the turn that raised the approval.
   */
  askId?: string
  /**
   * The reply is news to the person the turn runs as: a turn nobody asked for
   * (a reminder the platform started), so its reply reaches their attention feed
   * and push like a routine's post (`SendMessageParams.unprompted`).
   */
  unprompted?: boolean
  /**
   * Where the turn came from, for its durable record (turn-ledger.ts). Absent:
   * "chat" for a person's turn, "thread" for one that answers an existing message.
   */
  origin?: AgentTurnOrigin
  /**
   * The durable origin (a job) the turn runs for, unique per org: a re-run of
   * the same job finds this turn instead of starting a second one.
   */
  originRef?: string
  /**
   * Continue a turn an earlier attempt started (turn-resume.ts): its record,
   * claimed by this process, and its journaled complete steps. The user's
   * message is not persisted again; the steps are replayed as they were sent.
   */
  resume?: { turn: AgentTurnRow; steps: JournalStep[] }
  /**
   * A failed or interrupted turn of the same durable origin that a job retry
   * answers again (M5): reopened as a new attempt instead of opening a turn.
   */
  retryTurn?: AgentTurnRow
  /**
   * The turn id the caller records live frames under (stream-registry
   * `liveTurnKey`), kept on the record so a resume continues the same live
   * entry. Absent: the caller records without one (the chat route).
   */
  liveTurnId?: string
}

/** A finished turn's reply, returned instead of persisted (`persistReply: false`). */
export interface AgentTurnReply {
  content: string
  /** The turn's accumulated requiredScopes. */
  requiredScopes: string[]
  metadata: Record<string, unknown>
}

/**
 * One entry in an agent turn's chronological timeline: a run of reasoning text,
 * a tool call, or a run of answer text (so the words written between two tools
 * are drawn between them, not all after every tool). Emitted in the exact order the model produced them so the
 * UI renders a tool call at the point in the thinking where it was invoked. Tool
 * entries carry only the id — the full call (name/args/result/status) lives once
 * in `metadata.toolCalls`, which the renderer joins on.
 */
export type TurnTimelineEntry =
  | { kind: "reasoning"; text: string }
  // `step`: the model step the call was made in (0 = the first), so a later
  // turn replays one message per step even when no words separate the steps
  // (context.ts stepsFromTimeline): merged, they would not repeat the request
  // the model was sent, and the next turn would re-read them uncached.
  | { kind: "tool"; toolCallId: string; step?: number }
  | { kind: "text"; text: string }

interface RunAgentChatResult {
  userMessageId: string
  /** The person's message this turn answers (RunAgentChatParams.askId); the trigger when absent. */
  askId?: string
  /** The reply thread the turn answers in (A7), null for a channel turn. */
  replyRootId?: string | null
  fullStream: AsyncIterable<any>
  finalize: (params: {
    usage: {
      promptTokens: number
      completionTokens: number
      reasoningTokens?: number
      /** Input tokens of the run's FINAL step -- the real context size (compaction metric). */
      lastStepInputTokens?: number
    }
    finishReason: string
    text: string
    /** Each step's text exactly as streamed, in order, when `text` joins the steps as
     *  paragraphs (reply-flatten.ts): a retraction, counted on the streamed text, is
     *  cut from these and the steps joined again. */
    stepTexts?: readonly string[]
    reasoning?: string
    /** Ordered reasoning/tool interleave — see TurnTimelineEntry. */
    timeline?: TurnTimelineEntry[]
    /** Raw provider/tool error detail when finishReason==="error" — surfaced in the
     *  chat message + metadata.error so an errored turn is not a silent blank turn. */
    errorDetail?: string
    /** The failing error's own `code` (a string one), when it carries one. */
    errorCode?: string
    /** The failure's class when the error itself says it (the provider stopped responding). */
    errorNotice?: ProviderNoticeCode
    /** The text after the last tool call, for a caller that keeps no timeline
     *  (shared-thread-reply.ts). */
    finalStepText?: string
    steps: Array<{
      toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }>
      toolResults?: Array<{ toolCallId: string; result: unknown }>
      /** One per `tool-error` chunk: a call that produced no result. Its detail is
       *  what keeps the persisted row from being a bare `status: "error"`. */
      toolErrors?: Array<{ toolCallId: string; error: unknown }>
    }>
  }) => Promise<{
    /** Null when the reply was returned instead of persisted. */
    messageId: string | null
    creditCost: string
    finishReason: string
    /** Set when `persistReply` is false. */
    reply?: AgentTurnReply
    /**
     * What the room floor withheld, as category labels for the requester's
     * private card only (never scope or app names). Empty when nothing was.
     */
    withheldCapabilities: string[]
  }>
  /** Step-scoped bundle context shared with every tool's `execute` closure.
   *  The stream-iterating caller (e.g. `invokeAgentForThread`) lazy-inits
   *  `stepBundleId` on the first `tool-call` chunk of an agent step (under
   *  `PARALLEL_APPROVAL_BUNDLING`) and resets to null on `finish-step`. */
  stepCtx: StepContext
  /** The run's mutable discovered-tool set (also on the run frame). tool_search
   *  adds to it mid-run; prepareStep folds it into activeTools; finalize
   *  persists it to threads.metadata.agentDiscoveredTools. */
  discoveredTools: Set<string>
  /**
   * The turn's accumulated scopes AS THEY STAND AT THE MOMENT OF THE CALL, for
   * the stream-mirroring callers that live outside this function and therefore
   * cannot reach the run frame (`invokeAgentForThread`, the chat SSE route).
   *
   * A function, not an array, precisely because the set GROWS while the turn
   * runs: the fan-out gates each `agent_stream` chunk on the set accumulated so
   * far (spec-security.md A2, `websocket.ts` `hasStreamChunkAccess`), so a value
   * read once at stream start would tag every later chunk with a stale, too
   * narrow set and publish scoped content to the whole room.
   */
  turnAccumulatedScopes: () => string[]
  /**
   * Close the turn's visitor spend when it ends WITHOUT `finalize` (the client
   * went away before any output): a request already sent is billed, the turn
   * slot is given back. A no-op for every other org.
   */
  abandon?: () => Promise<void>
  /**
   * The demo refusal that stopped this visitor turn mid-way (a budget, the
   * step limit), with its visitor-facing text, or null.
   */
  demoRefusal?: () => Promise<{ code: DemoSpendCode; text: string } | null>
  /**
   * The agent this turn acted as, or null when none was resolvable. Returned
   * (rather than left on the run frame) for the after-the-turn work the route
   * fires outside every frame -- the auto-title, whose audit row would
   * otherwise name no agent at all (A11).
   */
  actingAgentId: string | null
  /**
   * Other people read this conversation (shared-thread-audience.ts). The
   * stream mirrors gate their text frames on it (shared-thread-reply.ts
   * `createLiveTextGate`): the room is never handed a step's working notes.
   */
  sharedThread: boolean
  /** The turn's durable record id (turn-ledger.ts). */
  turnId: string
  /**
   * True once another process owns the turn (a journal write was fenced):
   * the caller stops writing live frames, and finalize persists nothing.
   */
  turnFenced: () => boolean
  /** True once a draining process asked the turn to hand off (finalize then does). */
  turnHandoff: () => boolean
  /**
   * A provider failure the stream met (an in-band `error` part or a thrown
   * read). "retry": the provider stopped answering mid-step and the turn is
   * handed off to run again from its last complete step (finalize hands it
   * off; the cut step is neither shown as an error nor kept). "unavailable":
   * the same kind of failure with no re-run left, the turn ends failed with
   * the provider_unavailable line. null: any other failure.
   */
  onProviderFailure?: (error: unknown) => "retry" | "unavailable" | null
}

/**
 * The agent acting in a turn (D2), whatever the room kind. A routine tick acts
 * as the routine's own live owner agent; any other turn (channel mention, DM,
 * a tick whose routine names no live agent) acts as the requester's oldest
 * live personal agent. No unique index exists on (org, owner, kind), so the
 * order is explicit. Null when the requester has no live personal agent, and
 * null too when a turn NAMES an agent that is not a live agent of this org.
 */
export async function resolveActingAgent(
  tx: PrivilegedDb,
  orgId: string,
  requesterUserId: string,
  routineId: string | undefined,
  /** The agent an `@mention` addressed, when the turn names one (P4b-T16). */
  actingAgentId?: string,
): Promise<{ id: string; scopeCeiling: string[] } | null> {
  const live = and(eq(agents.orgId, orgId), isNull(agents.archivedAt))
  if (actingAgentId) {
    // A NAMED agent, resolved as a LIVE agent of THIS org and nothing else. An
    // id that does not resolve addresses NOBODY: falling through here would
    // hand the turn to the requester's own personal agent, which then speaks in
    // a room the named agent never joined (S12). The caller decides what an
    // unaddressed turn means; it is never a different agent.
    const [mentioned] = await tx
      .select({ id: agents.id, scopeCeiling: agents.scopeCeiling })
      .from(agents)
      .where(and(live, eq(agents.id, actingAgentId)))
      .limit(1)
    return mentioned ?? null
  }
  if (routineId) {
    const [routineAgent] = await tx
      .select({ id: agents.id, scopeCeiling: agents.scopeCeiling })
      .from(routines)
      .innerJoin(agents, eq(agents.id, routines.ownerAgentId))
      .where(and(eq(routines.id, routineId), eq(routines.orgId, orgId), live))
      .limit(1)
    if (routineAgent) return routineAgent
  }
  const [personal] = await tx
    .select({ id: agents.id, scopeCeiling: agents.scopeCeiling })
    .from(agents)
    .where(and(live, eq(agents.ownerUserId, requesterUserId), eq(agents.kind, "personal")))
    .orderBy(asc(agents.createdAt), asc(agents.id))
    .limit(1)
  return personal ?? null
}

/**
 * The acting agent and effective scope of a turn in `threadId` (D2), as every
 * non-override turn computes them: the acting agent's ceiling floored by the
 * room, never wider than the scopes the actor carries into the turn. Null when
 * no live agent acts; the turn then runs at the actor's scopes alone. A
 * room-floor error propagates rather than degrading to an unfloored scope.
 */
export async function resolveTurnScope(
  tx: PrivilegedDb,
  orgId: string,
  threadId: string,
  actor: { userId: string; scopes: string[] },
  routineId: string | undefined,
  /** The agent an `@mention` addressed, when the turn names one (P4b-T16). */
  actingAgentId?: string,
): Promise<{
  agentId: string
  agentCeiling: string[]
  effectiveScope: string[]
  withheld: string[]
  /** Who the room floor counts (scope-taint.ts, rule 15e); absent for a routine tick. */
  roomPeople?: string[]
} | null> {
  const agent = await resolveActingAgent(tx, orgId, actor.userId, routineId, actingAgentId)
  if (!agent) return null
  const { effectiveScope, withheld, roomPeople } = await computeEffectiveScopeForTurn(
    tx,
    orgId,
    threadId,
    actor.userId,
    agent.scopeCeiling,
  )
  return {
    agentId: agent.id,
    agentCeiling: agent.scopeCeiling,
    effectiveScope: intersectScopes(effectiveScope, actor.scopes),
    withheld,
    ...(roomPeople ? { roomPeople } : {}),
  }
}

/**
 * The acting agent and scope for a turn that names its own scope (Share
 * anyway). The override is used as given, never recomputed from the room, but
 * only when it lies within a fresh `ceiling ∩ requester grants` and within the
 * scopes the actor carries into the turn; anything else refuses the turn.
 */
async function resolveScopeOverride(
  tx: PrivilegedDb,
  orgId: string,
  actor: UserContext,
  override: { agentId: string; effectiveScope: string[] },
): Promise<{
  agentId: string
  agentCeiling: string[]
  effectiveScope: string[]
  withheld: string[]
  /** Never set: the override bypasses the room floor, its people included (rule 15e). */
  roomPeople?: string[]
}> {
  const [agent] = await tx
    .select({ id: agents.id, scopeCeiling: agents.scopeCeiling })
    .from(agents)
    .where(and(eq(agents.id, override.agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .limit(1)
  if (!agent) {
    throw new HTTPException(403, {
      message: "E_SCOPE_OVERRIDE_REFUSED: the override names no live agent of this org",
    })
  }
  const grants = (await loadEffectivePermissions(tx, actor.userId, orgId)).scopes
  const bound = intersectScopes(effectiveScopeDm(agent.scopeCeiling, grants), actor.scopes)
  if (!override.effectiveScope.every((s) => isScopeSubset([s], bound))) {
    throw new HTTPException(403, {
      message: "E_SCOPE_OVERRIDE_REFUSED: the override is wider than ceiling and requester",
    })
  }
  const effectiveScope = [...override.effectiveScope]
  return {
    agentId: agent.id,
    agentCeiling: agent.scopeCeiling,
    effectiveScope,
    withheld: withheldByRoom(agent.scopeCeiling, grants, effectiveScope),
  }
}

/** The tokens of the guide notes the thread's replies stored so far (THREAD_GUIDE_NOTES_TOKEN_CAP). */
export async function getThreadNotesTokens(threadId: string, orgId: string): Promise<number> {
  const rows = await withPrivilegedDb(orgId, "get-thread-notes-tokens", async (tx) =>
    tx
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          eq(messages.orgId, orgId),
          eq(messages.authorType, "agent"),
          sql`${messages.metadata} ? ${GUIDE_NOTES_META_KEY}`,
        ),
      ),
  )
  return storedNotesTokens(rows.map((r) => r.metadata))
}

export async function getLastInputTokens(threadId: string, orgId: string): Promise<number> {
  const row = await withPrivilegedDb(orgId, "get-last-input-tokens", async (tx) => {
    const [r] = await tx
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          eq(messages.orgId, orgId),
          eq(messages.authorType, "agent"),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1)
    return r
  })
  const meta = row?.metadata as {
    usage?: { inputTokens?: number; lastStepInputTokens?: number }
    stepCount?: number
  } | null
  // The compaction trigger needs the model's CONTEXT size, which is the input
  // token count of the run's FINAL step. `usage.inputTokens` is the SUM across
  // every step (billing), so a 20-step run reads as 20x the real context and
  // used to trip compaction on threads whose context was nowhere near the
  // window. Legacy rows predate `lastStepInputTokens`; approximate them by
  // dividing the sum over the step count.
  if (typeof meta?.usage?.lastStepInputTokens === "number") {
    return meta.usage.lastStepInputTokens
  }
  const summed = meta?.usage?.inputTokens ?? 0
  const stepCount = typeof meta?.stepCount === "number" && meta.stepCount > 0 ? meta.stepCount : 1
  return Math.round(summed / stepCount)
}

/**
 * The text of the message this turn is answering, read only when the caller
 * did not carry it (a turn triggered by an already stored message). One
 * indexed row, privileged: the row is the turn's own trigger, which the caller
 * has already been authorized for.
 */
async function triggerMessageText(orgId: string, messageId: string): Promise<string> {
  try {
    const [row] = await withPrivilegedDb(orgId, "agent-recall-trigger-text", (tx) =>
      tx
        .select({ content: messages.content })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.orgId, orgId)))
        .limit(1),
    )
    return row?.content ?? ""
  } catch (err) {
    log.warn({ err, orgId, messageId }, "Could not read the trigger message for recall")
    return ""
  }
}

/**
 * The reply root of the message a turn answers (A7): null for a channel
 * message, and null when the row cannot be read (a turn that cannot tell stays
 * in the channel, where it always answered).
 */
async function triggerReplyRootId(orgId: string, messageId: string): Promise<string | null> {
  try {
    const [row] = await withPrivilegedDb(orgId, "agent-trigger-reply-root", (tx) =>
      tx
        .select({ replyRootId: messages.replyRootId })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.orgId, orgId)))
        .limit(1),
    )
    return row?.replyRootId ?? null
  } catch (err) {
    log.warn({ err, orgId, messageId }, "Could not read the trigger message's reply root")
    return null
  }
}

/**
 * The level `checkpoint_advance_skipped` is logged at, or null for no line.
 * Only a tail over the budget with no advance is worth a line. `no-summary`
 * means the brief writer produced nothing: no eligible model, no credits, or a
 * provider that refused the call (a spend cap, an outage), each already logged
 * by the writer with its real reason. The raw tail is still trimmed to the
 * budget when the context is assembled, so the prompt stays bounded, and the
 * next turn retries the advance: a warn. Any other reason over the budget is
 * the advance's own logic failing to find a boundary, which is a bug.
 */
export function checkpointSkipLogLevel(advance: {
  advanced: boolean
  overBudget?: boolean
  reason?: string
}): "warn" | "error" | null {
  if (advance.advanced || advance.overBudget !== true) return null
  return advance.reason === "no-summary" ? "warn" : "error"
}

/** What the cold resume check decided, so a caller (and a test) can read it. */
export interface ColdResumeDecision {
  /** More than the warm window since this agent's last turn in this thread. */
  cold: boolean
  /** Wall seconds since that turn, or null when the agent has never turned here. */
  sinceLastTurnSeconds: number | null
  /** The advance ran and wrote a new checkpoint version. */
  advanced: boolean
}

/**
 * WHAT HAPPENS BETWEEN TWO TURNS OF AN AGENT IN A CONVERSATION, wherever the
 * turn runs: the cloud runtime calls it before assembling a turn's context,
 * and a local session's turn row calls it for a turn that runs on the user's
 * machine (`local-session-routes.ts`), so a conversation's checkpoint and its
 * memory episodes advance under the same rules and thresholds either way.
 * Never throws: each half costs cache or an episode, never the turn.
 */
export async function betweenTurnsUpkeep(params: {
  agentId: string
  threadId: string
  orgId: string
  actor: UserContext
  contextWindow?: number
  modelId?: string | null
}): Promise<void> {
  const { agentId, threadId, orgId, actor } = params
  // CHECKPOINT ADVANCE (spec-memory.md L4), BETWEEN TURNS. It runs after
  // the acting agent is known (a checkpoint is per agent) and BEFORE the
  // context is assembled, so every step of the turn below shares one prefix:
  // an advance inside a turn would rewrite the prefix mid-run, which is the
  // one thing invariant I3 forbids. It is a no-op until the raw tail is past
  // the budget, and the advance itself leaves 12,000 raw tokens behind, so it
  // fires at most once per 36,000 raw tokens.
  try {
    const advance = await advanceCheckpoint({
      agentId,
      threadId,
      orgId,
      actor,
      ...(params.contextWindow ? { contextWindow: params.contextWindow } : {}),
    })
    // A50 says the checkpoint advances once the raw tail passes the budget.
    // A thread over the budget that still does not advance is a conversation
    // whose prefix grows without bound, so it is ONE named line with the
    // reason. THE CONDITION IS THE TAIL, NOT THE REASON: the one thing worth a
    // line is that the tail was over the budget and no advance landed.
    const skipLevel = checkpointSkipLogLevel(advance)
    if (skipLevel) {
      log[skipLevel](
        {
          threadId,
          agentId,
          reason: advance.reason,
          estimatedTokens: advance.estimatedTokens,
          budgetTokens: advance.budgetTokens,
          modelId: params.modelId ?? null,
        },
        "checkpoint_advance_skipped",
      )
    }
  } catch (err) {
    // A failed advance costs cache, never the turn: the unadvanced history
    // still renders correctly, just longer.
    log.error({ err, threadId }, "Checkpoint advance failed, continuing with the raw history")
  }

  // ARM THE QUIET CLOSE (spec-memory.md L5, trigger (a)). Every turn re-arms
  // the same delayed job id, so the queue holds exactly one and it fires six
  // hours after the LAST turn of this thread rather than six hours after the
  // first. Armed at the start of the turn, not the end: a turn has several
  // exits and the six hour delay dwarfs the difference, while an unarmed
  // episode never closes at all.
  try {
    await armQuietClose({ orgId, agentId, threadId })
  } catch (err) {
    log.error({ err, threadId }, "Could not arm the episode quiet close")
  }
}

/**
 * THE COLD RESUME ADVANCE (P4c-T23), AT TURN START.
 *
 * A turn an hour or more after this agent's last one is not continuing a
 * conversation, it is picking one up: nobody, model or human, is in the middle
 * of the raw tail any more. So the tail is compressed ONCE, through the same
 * advance the budget path uses, down to the cold tail budget, and the rebuild
 * it causes is logged as its own cause rather than hiding inside the planned
 * `checkpoint` rebuilds.
 *
 * It runs BEFORE the context is assembled and is separate from the between
 * turns (budget) advance: this one is triggered by TIME, not by size, and a
 * cold tail that already fits does nothing and logs nothing. A routine tick
 * never cold resumes: its ticks are independent jobs anchored at their own
 * trigger message, so the wall gap between two of them means nothing.
 */
export async function coldResumeAdvanceForTurn(params: {
  agentId: string
  threadId: string
  orgId: string
  actor: UserContext
  contextWindow?: number
  /** A routine tick, which is exempt from the rule. */
  isRoutineTick?: boolean
  now?: Date
}): Promise<ColdResumeDecision> {
  const idle: ColdResumeDecision = { cold: false, sinceLastTurnSeconds: null, advanced: false }
  if (params.isRoutineTick) return idle
  const now = params.now ?? new Date()
  // ONE LOAD. The decision needs the rows (for the last agent turn) and the
  // tail estimate, which is exactly what the bounded load already returns.
  const loaded = await loadBoundedHistory({
    threadId: params.threadId,
    orgId: params.orgId,
    actor: params.actor,
    agentId: params.agentId,
    ...(params.contextWindow ? { contextWindow: params.contextWindow } : {}),
  })
  const lastTurn = lastAgentTurnCompletedAt(loaded.messages, params.agentId)
  if (!isColdResume({ lastAgentTurnCompletedAt: lastTurn, now })) return idle
  const sinceLastTurnSeconds = Math.floor((now.getTime() - (lastTurn as Date).getTime()) / 1000)
  // A COLD TAIL THAT ALREADY FITS IS LEFT ALONE. Summarizing it would rebuild
  // the prefix and buy nothing: the tail is already the size a cold resume
  // wants to hand the model. MEASURED PER MESSAGE, exactly as the boundary
  // measures it: measuring the joined text instead counts the newlines the
  // boundary does not, so a tail the advance just left at the budget would
  // read as over it and every later cold turn would advance again.
  const tailTokens = loaded.messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ""), 0)
  if (tailTokens <= COLD_TAIL_TOKEN_BUDGET) {
    return { cold: true, sinceLastTurnSeconds, advanced: false }
  }
  // `force`, because the trigger is the clock: the tail is usually well under
  // the budget the planned advance waits for, and waiting for it is what this
  // rule exists to stop doing.
  const result = await advanceCheckpoint({
    agentId: params.agentId,
    threadId: params.threadId,
    orgId: params.orgId,
    actor: params.actor,
    ...(params.contextWindow ? { contextWindow: params.contextWindow } : {}),
    force: true,
    tailReserveTokens: COLD_TAIL_TOKEN_BUDGET,
    cause: "cold_resume",
    sinceLastTurnSeconds,
  })
  return { cold: true, sinceLastTurnSeconds, advanced: result.advanced }
}

export async function runAgentChat(params: RunAgentChatParams): Promise<RunAgentChatResult> {
  // The turn is live on its thread from here until finalize (or a failure before it returns), so a
  // turn starting meanwhile does not reset the untrusted-content mark this one may set
  // (scopes/live-runs.ts, scopes/taint.ts).
  const liveRunId = crypto.randomUUID()
  // Awaited (bounded, never rejects): a turn starting on another process right after sees it.
  const endLiveRun = await beginLiveRun(threadRunKey(params.threadId), liveRunId)
  // A visitor turn's step meter, once preCheck opened it: a turn that fails
  // before its stream is handed back closes it here, or its turn slot and its
  // hold would stay taken until they expire.
  let demoMeter: { finish(total?: number): Promise<void> } | undefined
  try {
    const result = await runAgentChatTurn(params, liveRunId, (meter) => {
      demoMeter = meter
    })
    const finalize = result.finalize
    return {
      ...result,
      finalize: async (finalParams) => {
        endLiveRun()
        return finalize(finalParams)
      },
    }
  } catch (err) {
    endLiveRun()
    await demoMeter?.finish()
    throw err
  }
}

async function runAgentChatTurn(
  params: RunAgentChatParams,
  liveRunId: string,
  onDemoMeter: (meter: { finish(total?: number): Promise<void> }) => void,
): Promise<RunAgentChatResult> {
  const {
    threadId,
    content,
    modelId,
    currentView,
    actor,
    orgId,
    skipUserPersist,
    userMessageId: providedUserMessageId,
    requestSignal,
  } = params
  const persistReply = params.persistReply ?? true
  // Approvals requested from here on were parked by this turn (false-approval-guard.ts).
  const turnStartedAt = new Date()
  if (!persistReply && !(skipUserPersist && providedUserMessageId)) {
    throw new Error("a non-persisting turn answers an existing message: pass userMessageId")
  }

  // Ensure the org runtime is initialized in this process before any tool- or app-backed work.
  await ensureAppsForOrg(orgId)
  // The tool set below reads the org's hidden apps (S14) synchronously.
  await primeOrgApps(orgId)

  // 1+2 in parallel: user message insert, last-input-tokens lookup, credit
  // pre-check. The three steps don't share data — user-msg id is only needed
  // for the SSE message-start event after the orchestrator returns, and the
  // compaction branch only reads `lastInputTokens`. Before this fan-out the
  // p95 first-token latency under 10 concurrent VUs sat at 540ms with stub
  // provider (k6 A3); after, the same workload measures comfortably under
  // the spec-mandated 500ms because the three DB round-trips overlap.
  const userMsgPromise: Promise<{ id: string } | null> =
    skipUserPersist && providedUserMessageId
      ? Promise.resolve({ id: providedUserMessageId })
      : withPrivilegedDb(orgId, "agent-user-msg", async (tx) => {
          return sendMessage(tx as unknown as RlsClient, {
            requiredScopes: [],
            orgId,
            userId: actor.userId,
            threadId,
            content,
            authorType: "user",
          })
        })
  const lastInputTokensPromise = getLastInputTokens(threadId, orgId)
  // A turn: nothing picked means the org's Auto setting, and a stored model
  // that is no longer available runs on Auto (S4, S5).
  const creditCheckPromise = preCheck(orgId, modelId, { turn: true })
  const [userMsg, lastInputTokens, creditCheck] = await Promise.all([
    userMsgPromise,
    lastInputTokensPromise,
    creditCheckPromise,
  ])
  if (creditCheck.allowed && creditCheck.demo) onDemoMeter(creditCheck.demo)

  if (!userMsg) {
    throw new HTTPException(403, { message: "Not a participant of this thread" })
  }
  const userMsgId = userMsg.id
  // The person's message this turn answers: the trigger, unless the caller
  // carries an earlier ask (an approved call's handed-back turn).
  const askId = params.askId ?? userMsgId
  // WHERE THE TURN ANSWERS (A7): an explicit root wins, else the triggering
  // message's own. A turn asked in a reply thread answers in it, whoever
  // started the turn.
  const replyRootId =
    params.replyRootId !== undefined
      ? params.replyRootId
      : await triggerReplyRootId(orgId, userMsgId)

  let compactionFallbackMessages: Array<{ role: string; content: unknown }> | undefined

  if (!creditCheck.allowed) {
    // Only 402 (out of credits) warrants a system message in the thread; config/model
    // errors (400/500) are caller errors and should not pollute the thread history.
    if (persistReply && creditCheck.persistSystemMessage) {
      await withPrivilegedDb(orgId, "agent-system-msg", async (tx) => {
        await sendMessage(tx as unknown as RlsClient, {
          requiredScopes: [],
          orgId,
          userId: actor.userId,
          threadId,
          content: creditCheck.reason ?? "Out of agent usage",
          authorType: "system",
          // The turn ends here, refused: the person who started it is told
          // like any other end of their turn (an agent's ask is not theirs).
          endsTurn: !params.coordination?.callerAgentId,
          parentMessageId: params.coordination?.parentMessageId ?? null,
          replyRootId,
          // Every refusal row says it is one (`turnRefusal`), so the client
          // draws it once as the conversation's system line and keeps the
          // failed turn's live block and state line quiet (turn-refusal.ts).
          // A demo spend refusal also carries its code, so the client can act
          // on it (the email-code prompt, the next-steps dialog); an unpaid
          // renewal or a spent balance carries its code (the Billing link). Any
          // other refusal shows its own reason: paying would not cure it.
          metadata: {
            turnRefusal: true,
            // The message refused: a later turn's replay leaves it out (context.ts).
            refusedMessageId: userMsgId,
            ...(creditCheck.code
              ? { demoRefusal: creditCheck.code }
              : creditCheck.billingCode === PAYMENT_REQUIRED_CODE ||
                  creditCheck.billingCode === OUT_OF_CREDITS_CODE
                ? { billingRefusal: creditCheck.billingCode }
                : {}),
          },
        })
      })
    }
    if (creditCheck.code) {
      throw new DemoSpendHttpError(creditCheck.code, creditCheck.reason)
    }
    // An unpaid renewal: 402 `payment_required`, so the client offers Billing.
    if (creditCheck.billingCode === PAYMENT_REQUIRED_CODE) throw new PaymentRequiredError()
    // Every coded (demo) refusal left above; the rest are 400, 402 or 500.
    const status =
      creditCheck.status === 402 || creditCheck.status === 500 ? creditCheck.status : 400
    throw new HTTPException(status, {
      message: creditCheck.reason ?? "Agent unavailable",
    })
  }

  // A resumed turn's journal holds its model's provider metadata (reasoning
  // signatures): on any other model the replay is refused (L7), so a model
  // removed in between ends the turn clearly instead of on Auto.
  const resumedModel = params.resume?.turn.resumeInput.modelId
  if (resumedModel && creditCheck.model.modelId !== resumedModel) {
    throw new TurnResumeRefused("model_unavailable")
  }

  // 2a. A person typed this turn: not a routine tick, not background work, not an agent's ask,
  // not a message from a restricted session (a program holding a capped token, session-ceiling.ts).
  const humanTypedTurn =
    !(params.background ?? false) &&
    !params.routineId &&
    !params.coordination &&
    !params.agentDispatched &&
    !params.sessionRestricted

  // 2b. Acting agent (D2) and this turn's effective scope, for every room kind
  // (channel mention, DM, routine tick). A turn with no resolvable agent leaves
  // the agent fields off the frame and keeps the actor-scope-only behaviour.
  // Once an agent is resolved the scope is computed fail-closed: a room-floor
  // error aborts the turn rather than running it unfloored. Resolved before
  // typing:start so an aborted turn never leaves an unbalanced indicator. The
  // user message is already persisted by then (callers persist it first).
  // `withheld` is the ceiling the room floor narrowed away: raw scope names,
  // private to the requester, kept on the frame and never rendered raw.
  const actingAgent = await withPrivilegedDb(orgId, "agent-effective-scope", async (tx) => {
    if (params.scopeOverride) {
      return resolveScopeOverride(tx, orgId, actor, params.scopeOverride)
    }
    return resolveTurnScope(tx, orgId, threadId, actor, params.routineId, params.actingAgentId)
  })

  // 2b'. A4: a DELEGATED turn runs at the scope the hand off computed
  // (`delegateToAgent`: the caller's effective scope INTERSECT this agent's
  // ceiling), not at what this agent would resolve on its own. Recomputing here
  // is how a delegation would quietly widen back to the callee's own ceiling.
  // `withheld` is re-derived from the SAME ceiling and the SAME scope, so the
  // requester's card keeps naming one thing.
  //
  // The delegated scope (callee ceiling ∩ the requester's grants) is further
  // floored by THIS room, exactly as a person's direct mention of the callee
  // here would be: `actingAgent.effectiveScope` is already that room-floored
  // scope, so the turn gets the intersection of both and never more.
  const delegatedScope = params.coordination?.delegatedScope
  if (actingAgent && delegatedScope) {
    actingAgent.effectiveScope = intersectScopes(
      intersectScopes(delegatedScope, actor.scopes),
      actingAgent.effectiveScope,
    )
    actingAgent.withheld = withheldByRoom(
      actingAgent.agentCeiling,
      actor.scopes,
      actingAgent.effectiveScope,
    )
  }

  // 2b''. A RESUMED turn runs with the restrictions it started under, never
  // wider (S10, H1). The same agent acts (M6: an archived agent, or another
  // one the resolution would fall back to, refuses the resume), and its scope
  // is capped by the effective scope the turn started with.
  if (params.resume) {
    const started = params.resume.turn.resumeInput
    if ((actingAgent?.agentId ?? null) !== (started.actingAgentId ?? null)) {
      throw new TurnResumeRefused("agent_unavailable")
    }
    const startScope = (started.actor as { effectiveScope?: unknown } | undefined)?.effectiveScope
    if (actingAgent && Array.isArray(startScope)) {
      actingAgent.effectiveScope = intersectScopes(
        actingAgent.effectiveScope,
        startScope.filter((s): s is string => typeof s === "string"),
      )
      actingAgent.withheld = withheldByRoom(
        actingAgent.agentCeiling,
        actor.scopes,
        actingAgent.effectiveScope,
      )
    }
  }

  // The untrusted-content mark covers the turn that read the outside text, not the thread's life:
  // a turn the person typed starts clean (scopes/taint.ts). Its history may still replay outside
  // text (an earlier tool result, a checkpoint summarising one), and that history is what the
  // compaction, the checkpoint advance and their memory flush below read, before context assembly
  // ever runs: the turn is marked again here, first.
  if (humanTypedTurn) {
    await clearTaintFlag(threadId, orgId, { ownRunId: liveRunId })
    const replayed = await loadBoundedHistory({
      threadId,
      orgId,
      actor,
      ...(actingAgent?.agentId ? { agentId: actingAgent.agentId } : {}),
      ...(replyRootId ? { replyRootId } : {}),
    })
    await markTurnIfReplaysOutsideText(threadId, orgId, [
      ...(replayed.checkpoint
        ? [checkpointAsHistoryRow(replayed.checkpoint, { threadId, orgId })]
        : []),
      ...replayed.messages,
    ])
  }

  // FRESH DISCOVERIES PER TICK: a routine tick's caller passes its own per-tick
  // Set (shared by reference across the supervisor's `length` re-loop turns).
  // The routine output thread accumulates discoveries FOREVER (25 tools → the
  // FULL instruction blocks + schemas of 7 apps, ~200k chars, in EVERY step's
  // prefix from step 1 — measured in prod). A tick must start from the lean
  // core surface and unlock only what THIS run actually uses; discoveries are
  // still persisted to the thread afterwards for observability, but ticks
  // never seed from that ever-growing set.
  //
  // INTERACTIVE CHAT keeps thread continuity through the same window as its
  // history: the persisted discoveries load WINDOWED to the acting agent's
  // checkpoint boundary (discovery-window.ts). A personal agent's DM is one
  // thread for the life of the account, and loading its whole persisted set
  // was measured at 184 schemas plus 48,000 tokens of app guides per step.
  // This runs after the acting agent is resolved because the boundary is that
  // agent's own checkpoint.
  const windowed = params.seedDiscoveredTools
    ? null
    : await loadWindowedDiscoveries({
        threadId,
        orgId,
        actor,
        agentId: actingAgent?.agentId ?? null,
      })
  const discoveredTools: Set<string> =
    params.seedDiscoveredTools ?? windowed?.discovered ?? new Set()
  // What the thread column held at the start (chat), or the seed itself (tick):
  // finalize writes the column only when the set it ends with differs.
  const persistedDiscoveredNames = windowed ? windowed.persisted : [...discoveredTools].sort()
  // The order the thread's last turn sent its tools in (its reply's `toolOrder`).
  const threadToolOrder = windowed?.toolOrder ?? []
  const discoveredAtStart = new Set(discoveredTools)
  // Turns since each tool was last used or loaded: the tool budget sheds the
  // least recently useful first. A routine tick starts fresh and has none.
  const toolRecencyMap: ReadonlyMap<string, number> = windowed?.recency ?? new Map()

  // 1.5 (moved to 2b'). Compaction check, BETWEEN REQUESTS, never mid call. It
  // runs after the acting agent is resolved because an agent turn compacts into
  // that agent's OWN checkpoint rather than into a thread wide message row
  // (P4m-T17), and the agent is not known before this point.
  // A non-persisting turn writes nothing to the room, so it never compacts.
  // A reply turn never compacts the CHANNEL (A8): its history is its own
  // reply thread, and the channel's context is not this turn's to rewrite.
  if (persistReply && lastInputTokens > 0 && !replyRootId) {
    const compactionModelResult = await resolveModelForPreCheck(orgId, modelId, { turn: true })
    if ("model" in compactionModelResult) {
      const compactionResult = await runCompaction({
        threadId,
        orgId,
        actor,
        lastInputTokens,
        contextWindow: compactionModelResult.model.contextWindow,
        ...(actingAgent?.agentId ? { agentId: actingAgent.agentId } : {}),
      })
      if (compactionResult.compacted) {
        log.info({ threadId, lastInputTokens }, "Compaction completed")
      } else if (compactionResult.fallbackMessages) {
        log.warn({ threadId }, "Using compaction fallback (aggressive prune) for this request")
        compactionFallbackMessages = compactionResult.fallbackMessages
      }
    }
  }

  // 2b''. COLD RESUME ADVANCE (P4c-T23), AT TURN START. Before the size driven
  // advance below, because a cold turn that compresses to the cold tail budget
  // leaves that one under budget with nothing left to do: the turn rebuilds its
  // prefix once, not twice.
  let coldResume: ColdResumeDecision = {
    cold: false,
    sinceLastTurnSeconds: null,
    advanced: false,
  }
  if (persistReply && actingAgent?.agentId && !replyRootId) {
    try {
      coldResume = await coldResumeAdvanceForTurn({
        agentId: actingAgent.agentId,
        threadId,
        orgId,
        actor,
        contextWindow: creditCheck.model.contextWindow,
        ...(params.routineId ? { isRoutineTick: true } : {}),
      })
    } catch (err) {
      // Same trade as the advance below: a failed compression costs cache, not
      // the turn.
      log.error({ err, threadId }, "Cold resume advance failed, continuing with the raw history")
    }
  }
  if (coldResume.cold) {
    log.info(
      {
        threadId,
        agentId: actingAgent?.agentId ?? null,
        sinceLastTurnSeconds: coldResume.sinceLastTurnSeconds,
        advanced: coldResume.advanced,
      },
      "agent_turn_cold_resume",
    )
  }

  // 2c + 2d. THE BETWEEN-TURNS UPKEEP: the checkpoint advance and the episode
  // quiet close, in `betweenTurnsUpkeep` below, which a turn that ran on the
  // user's own machine goes through too (`local-session-routes.ts`).
  // A8: a reply turn neither reads nor advances the channel's checkpoint.
  if (persistReply && actingAgent?.agentId && !replyRootId) {
    await betweenTurnsUpkeep({
      agentId: actingAgent.agentId,
      threadId,
      orgId,
      actor,
      contextWindow: creditCheck.model.contextWindow,
      modelId: creditCheck.model.modelId,
    })
  }

  // 3. Broadcast typing:start (after preCheck so clients never see an unbalanced indicator).
  // A non-persisting turn is invisible to the room.
  if (persistReply) {
    broadcastEphemeral({
      app: "kernel",
      entity: "typing",
      action: "start",
      entityId: threadId,
      orgId,
      actorId: actor.userId,
      actorType: "agent",
      // H6: WHICH agent is typing. A channel can hold several, and a frame
      // that names only the actor collapses them into one indicator.
      // A7: a turn answering in a reply thread is announced in that thread's
      // panel, not on the channel's state line.
      data: {
        authorType: "agent",
        userId: actor.userId,
        agentId: actingAgent?.agentId ?? null,
        ...(replyRootId ? { replyRootId } : {}),
      },
    }).catch((err) => log.error({ err }, "Failed to broadcast typing:start"))
  }

  // 4. Resolve model instance
  // Generations of this turn that OpenRouter streamed and the turn stopped before their usage
  // came back: billed all the same, so finalize records them from OpenRouter's own record.
  const unreportedGenerations: string[] = []
  const model = await resolveModelFromCredit(creditCheck, {
    // Inert for every real provider; the e2e scripted provider uses it to pick
    // which thread's (or routine's) script this turn replays.
    threadId,
    scriptTurnId: userMsgId,
    ...(params.routineId ? { routineId: params.routineId } : {}),
    onUnreportedGeneration: (id) => unreportedGenerations.push(id),
    // The cold resume's idle compaction keeps this turn's requests (context/warm-compaction.ts),
    // for the turns the cold resume applies to.
    ...(persistReply && actingAgent?.agentId && !replyRootId && !params.routineId
      ? {
          idleCompaction: {
            orgId,
            agentId: actingAgent.agentId,
            actor,
            modelKey: creditCheck.model.modelId,
            contextWindow: creditCheck.model.contextWindow,
          },
        }
      : {}),
  })

  // 4b. Resolve reasoning. Clamp the requested level to what the model supports,
  //     then map it to that provider's quirky providerOptions (always requesting
  //     maximum visibility — full text, summary, or none — see buildReasoning).
  const reasoningCapability = getReasoningCapability(
    creditCheck.model.modelId,
    creditCheck.model.provider,
    creditCheck.model.reasoningCaps,
  )
  // A model Auto picked runs at Auto's level (Low for the visitor pin on a demo
  // box key, else the org's default level, else High); any other turn at the
  // level asked for (conversation, else routine), else the org's default level,
  // else the model's own default. Either is
  // clamped to what this model allows — in particular, models that cannot
  // disable thinking (e.g. Gemini Pro family) have "off" excluded from
  // `allowedLevels`, so a stale/explicit "off" request falls back to the
  // model's default (an ON level) instead of reaching the provider as a
  // disable request it will reject with HTTP 400.
  const effectiveReasoningLevel: ReasoningLevel = resolveTurnReasoningLevel({
    capability: reasoningCapability,
    requested: params.reasoningLevel,
    autoPicked: creditCheck.model.autoPicked === true,
    autoLevel: creditCheck.model.autoReasoningLevel,
    orgDefault: creditCheck.model.orgDefaultReasoningLevel,
  })
  const reasoningPlan = buildReasoning(
    creditCheck.model.provider,
    effectiveReasoningLevel,
    creditCheck.model.upstreamId,
    creditCheck.model.reasoningCaps,
  )

  // 5. Build tool set
  //
  // The chat agent's `runAgentChat` invocation is the "root" agent run from
  // the kernel's perspective — a fresh `runId` is minted for it so any
  // `spawn_agent` tool call inside this loop chains `parent_run_id` onto the
  // root run. The frame is plumbed into `buildToolSet` rather than wrapped
  // around `runAgentStream` because AI SDK executes tools from inside its
  // own stream-processing queue (consumed by the caller's
  // `for await (chunk of fullStream)` loop in `invokeAgentForThread`), so an
  // ALS frame opened here would not propagate to those callbacks otherwise.
  const rootRunId = crypto.randomUUID()
  // A demo visitor's turn (step budget, visitor tool result limits).
  const visitorTurn = await isVisitorTurn(orgId, creditCheck.demo !== undefined)
  const noOwnComputer = await personHasNoComputer(orgId, actor)
  // A routine run's token account (S17, A34), inherited BY REFERENCE from the
  // frame this turn was started in: the routine tick's frame, or the asking
  // turn's frame for an agents_ask callee. Every step of this turn adds to it,
  // so a sub-run's tokens count toward the parent's hard limit.
  const inherited = inheritedRunFields(currentRunContext())
  const tokenAccount = inherited.tokenAccount
  const runFrame = {
    runId: rootRunId,
    parentRunId: null,
    rootRunId,
    nestingDepth: 0,
    // Carry the caller's foreground/background intent down to every tool the
    // chat dispatches (tool-bridge.executeWrapper reads this off the ALS frame).
    background: params.background ?? false,
    // Deferred-tool discovery state for this run: seeded from the thread's
    // persisted discoveries, mutated by the tool_search handler mid-run, read
    // by prepareStep below to expand activeTools on the next step.
    discoveredTools,
    // Routine tick: stamp the routineId so buildToolSet admits the routine-only tools (web_watch /
    // watch_state). Absent for foreground/non-routine runs ⇒ those tools stay invisible (as intended).
    ...(params.routineId ? { routineId: params.routineId } : {}),
    // The routine tick's mailbox reader (routine-mailbox-trust.ts), only into
    // the turn of THAT routine's tick, never into an ask or another run.
    ...(params.routineId &&
    !params.coordination &&
    currentRunContext()?.routineId === params.routineId &&
    currentRunContext()?.routineMailboxReaderUserId
      ? { routineMailboxReaderUserId: currentRunContext()?.routineMailboxReaderUserId }
      : {}),
    // A follow-up routine's tick (routines.follow_up): its turn stages drafts
    // and runs on instead of pausing, and its mail checks as a follow-up.
    // Only into the turn of THAT routine's tick, as the reader above.
    ...(params.routineId &&
    !params.coordination &&
    currentRunContext()?.routineId === params.routineId &&
    currentRunContext()?.routineFollowUp === true
      ? { routineFollowUp: true }
      : {}),
    // The same tick's park signal (routine-mailbox-wait.ts), and the browser
    // nonce of a run its owner started with Run now: only into the turn of
    // THAT routine's tick, under the same rule as the reader above.
    ...(params.routineId &&
    !params.coordination &&
    currentRunContext()?.routineId === params.routineId &&
    currentRunContext()?.routineMailboxReaderUserId
      ? {
          ...(currentRunContext()?.routineMailboxWait
            ? { routineMailboxWait: currentRunContext()?.routineMailboxWait }
            : {}),
          ...(currentRunContext()?.mailboxTurnNonce && !params.mailboxTurnNonce
            ? { mailboxTurnNonce: currentRunContext()?.mailboxTurnNonce }
            : {}),
          ...(currentRunContext()?.mailboxHandoff
            ? { mailboxHandoff: currentRunContext()?.mailboxHandoff }
            : {}),
        }
      : {}),
    // An agents_ask (coordinated) turn: an agent asked, no person is waiting.
    ...(params.coordination
      ? {
          coordinated: true,
          coordinatedBy: params.coordination.callerAgentId
            ? ("agent" as const)
            : ("external-app" as const),
        }
      : {}),
    // See humanTypedTurn above.
    // Code on the person's own machine (run_on_my_computer) runs without an approval only here.
    humanTurn: humanTypedTurn,
    ...(visitorTurn ? { visitorTurn: true } : {}),
    // A person with no computer set up for Liaison is offered no tool that reads one.
    ...(noOwnComputer ? { noOwnComputer: true } : {}),
    // Client-minted turn nonce for the mailbox decrypt protocol. Its presence is
    // what lets this turn ask the browser to decrypt; its absence is the locked
    // path (blueprint Task 9.2).
    ...(params.mailboxTurnNonce ? { mailboxTurnNonce: params.mailboxTurnNonce } : {}),
    ...(params.sessionRestricted ? { sessionRestricted: true } : {}),
    // Acting agent, its ceiling and this turn's effective scope; absent when no
    // agent is resolvable for the thread.
    ...(actingAgent ?? {}),
    // Share anyway's rerun: a read-only catalog, so re-answering the turn
    // cannot repeat its side effects. Absent ⇒ an ordinary turn, which writes.
    ...(params.readOnlyTools ? { readOnlyTools: true } : {}),
    // Every turn unions the declared scopes of the tools it calls, whether or
    // not an agent is resolvable for the thread.
    // The message this turn answers. `agents_ask` hangs its question under it.
    turnMessageId: userMsgId,
    // The person's message the turn answers; a gated call records it on its approval.
    askId,
    // A7: the reply thread this turn answers in, for the writes made from
    // inside the frame (a gated tool's approval card).
    ...(replyRootId ? { replyRoot: { threadId, rootMessageId: replyRootId } } : {}),
    turnScopeAccumulator: createTurnScopeAccumulator({ orgId }),
    // Flipped by the tool bridge on the first scope-taint refusal of the turn;
    // read when the withheld block is built, so the card can tell the
    // requester a rerun would be refused rather than offer one.
    scopeTaintRefused: false,
    // The calls that marked the turn as having read outside text, stored on each call (finalize).
    taintedToolCallIds: new Set<string>(),
    // Filled once the tool set is built below (tool-search.ts reads it).
    turnToolNames: new Set<string>(),
    // Set once the tool set is built below (tool-search.ts calls it).
    admitTools: undefined as RunContext["admitTools"],
    fixedToolList: undefined as RunContext["fixedToolList"],
    // Set once the run's clip ledger exists (web-fetch-repeat.ts reads it).
    clipLedger: undefined as RunContext["clipLedger"],
    // Set once the turn's history is assembled (kernel-result-hints.ts).
    resultHintsShown: undefined as RunContext["resultHintsShown"],
    // Set right before the model runs (openDurableTurn below).
    turnRecord: undefined as RunContext["turnRecord"],
    ...inherited,
  }
  // The caller's taint rides into the delegated turn: what the asking agent had
  // already read is what this turn's own writes must be judged against.
  if (params.coordination?.callerTaintScopes?.length) {
    runFrame.turnScopeAccumulator.recordInjected(params.coordination.callerTaintScopes)
  }

  // Step-scoped bundle id allocated lazily on the first gated `tool-call` chunk
  // of each agent step (see the `tool-call` branch of the stream loop). Reset
  // on `finish-step`. Every gated approval created inside one step shares this
  // id, surfaced as one bundle on the FE. Off when the flag is unset.
  const stepCtx: StepContext = { stepBundleId: null, answerOnly: null, chainOnly: null }
  // Build the FULL executable set (deferred included) — a tool discovered
  // mid-run must be callable on the very next step. What the PROVIDER sees per
  // step is gated separately via activeTools/prepareStep below, so the schema
  // catalog of undiscovered app tools never reaches the request payload.
  const tools = buildToolSet(
    orgId,
    actor,
    threadId,
    ALL_DEFERRED_TOOLS_UNLOCKED,
    "agent",
    runFrame,
    stepCtx,
  )
  for (const name of Object.keys(tools)) runFrame.turnToolNames.add(name)
  // Deferred SDK names the actor could unlock (scope-visible, chat-reachable).
  const deferredNames = new Set(
    listDeferredTools(orgId, actor, "agent", false, { noOwnComputer }).map((t) => t.sdkName),
  )
  // A tool registered after the set above was built (an MCP server's tool list
  // arriving with the dial tool_search makes) joins it when tool_search loads
  // it, so it is callable on the next step of THIS turn. Only the loaded names
  // join, and they join as deferred: the rest of a late server's catalog stays
  // one search away, like any app tool.
  runFrame.admitTools = (names) => {
    const { admitted, callable } = admitLateTools(names, tools, () =>
      buildToolSet(orgId, actor, threadId, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", runFrame, stepCtx),
    )
    for (const name of admitted) {
      runFrame.turnToolNames.add(name)
      deferredNames.add(name)
    }
    return callable
  }
  const computeActiveTools = () =>
    Object.keys(tools).filter((n) => !deferredNames.has(n) || discoveredTools.has(n))
  // THE TOOL SCHEMA BUDGET. The discoveries this turn STARTS with (a routine
  // tick's scope seed, a chat's windowed set) are bounded here, least recently
  // useful first (turn-tool-budget.ts); what goes stays in the deferred catalog,
  // one tool_search away, and an app's guide leaves the assembled prefix with
  // its last tool. Discoveries made
  // during the turn are the agent asking for a tool and are not trimmed.
  // "One tool_search away" holds only when the turn can call tool_search: a
  // routine whose scopes do not carry its gate (`kernel:threads:read`) cannot,
  // so a trimmed app would be gone for the whole tick (a support tick lost
  // every tickets tool this way). Such a turn keeps its seed whole.
  //
  // THE REQUEST'S OWN APPS (turn-focus.ts). A HARD focus app (the entity the
  // thread was made for, the event that fired a routine tick, a demo
  // visitor's view) is loaded from the first step, within a share of the
  // budget, and shed before the tools the last turns used: the budget once shed
  // the largest app first, which in an org with every app installed was the
  // tickets app on a ticket, and the agent spent its turn searching for it.
  // A SOFT focus app (the view a person's message was sent from, in any
  // other org) only fills the room the budget left: the client's active tab
  // never pushes out what the conversation itself loaded.
  const focus = await resolveTurnFocus({
    orgId,
    threadId,
    currentView: currentView ?? null,
    routineId: params.routineId ?? null,
    visitorTurn,
    appsWithTools: new Set(Object.keys(tools).map(appOfSdkToolName)),
  })
  const focusApps = focusAppNames(focus)
  const hardFocusApps = focusAppNames(focus, true)
  const toolDefs = withFocusCore(
    orgId,
    hardFocusApps,
    tools as Record<string, { description?: string; inputSchema?: unknown }>,
  )
  // THE TOOLS THE LAST TURN SENT STAY. A tool that leaves the list moves every
  // tool after it, and the provider then re-reads the request from there: on
  // an upstream that renders the tools ahead of the conversation, the whole
  // conversation. Keeping an unused tool costs its schema at the cached
  // price; dropping it costs the conversation at the full one. So a turn
  // starts with what the last one sent (its reply's `toolOrder`), counted as
  // its starting surface like a preload: carrying never keeps a tool loaded
  // by itself in the discovery window. The budget below still sheds a
  // carried tool the conversation has not used, first, when room is needed.
  const carried = new Set<string>()
  for (const name of threadToolOrder) {
    if (!(name in tools) || !deferredNames.has(name) || discoveredTools.has(name)) continue
    discoveredTools.add(name)
    discoveredAtStart.add(name)
    carried.add(name)
  }
  const preloaded: string[] = []
  // An app with a core list (manifest `focusCore`) preloads that list; its
  // other tools are listed by name and purpose once the budget has run, below.
  const focusPlan = focusCorePreload({
    candidates: Object.keys(tools).filter(
      (name) =>
        deferredNames.has(name) &&
        !discoveredTools.has(name) &&
        hardFocusApps.has(appOfSdkToolName(name)),
    ),
    tools: toolDefs,
    focus,
  })
  for (const name of focusPlan.preload) {
    discoveredTools.add(name)
    // Counted as the turn's starting surface, not as its own discovery: a
    // preload is no evidence the conversation used the app, so it does not
    // keep the app loaded for the turns after this one (discovery-window.ts).
    // The evidence is re-read every turn, and it does not change with the tab.
    discoveredAtStart.add(name)
    preloaded.push(name)
  }
  // THE THREAD'S TOOL LIST IS FIXED (providers/fixed-tool-list.ts) when the
  // turn can call a loaded tool through kernel__call_tool: the tools the last
  // turn sent are the list, so none of them may be shed.
  const fixedListMode = CALL_TOOL_SDK_NAME in tools
  // A hard focus app's tools off its core list, listed by name only (below).
  const focusIndexed = new Set<string>()
  // THE TOOLS LOADED ON SPECULATION (the apps the last turns worked, the
  // view's app): most are never called, and on a fixed list a loaded tool's
  // schema rides a guide note that stays in the history for good. They are
  // listed by name and purpose instead; a tool's schema follows once the model
  // asks for it (a search naming it, a call), see isIndexOnly below.
  const speculativeTools = new Set<string>()
  {
    const visibleAtStart = computeActiveTools()
    const canDiscover = "kernel__tool_search" in tools
    const preloadedSet = new Set(preloaded)
    // Least recently useful first (turn-tool-budget.ts): what the last turns
    // used or loaded is shed last, after the conversation's older discoveries
    // and after the focus app's preload. A turn that cannot call tool_search
    // keeps what it was seeded with; only its own preload may go back.
    const budget = planTurnToolBudget({
      visible: visibleAtStart,
      tools: toolDefs,
      droppable: (name) =>
        deferredNames.has(name) &&
        discoveredTools.has(name) &&
        !(fixedListMode && carried.has(name)) &&
        (canDiscover || preloadedSet.has(name) || carried.has(name)),
      preloaded: preloadedSet,
      hardFocusApps,
      focus,
      recency: toolRecencyMap,
      cap: TURN_TOOL_SCHEMA_TOKEN_CAP,
      logContext: { orgId, threadId, agentId: actingAgent?.agentId ?? null },
    })
    for (const name of budget.drop) {
      discoveredTools.delete(name)
      discoveredAtStart.delete(name)
    }
    const overflow = budget.drop.filter((name) => hardFocusApps.has(appOfSdkToolName(name)))
    // THE APPS THE LAST TURNS WORKED: their other tools fill the room left
    // before a view's app does. The conversation is the strongest evidence of
    // what a vague follow-up ("go ahead", "HELLO ?") is about, and a step of
    // the last turn's work often needs a tool of the same app it had not
    // called yet. Counted as the starting surface, like a preload, so filling
    // never keeps an app loaded by itself: only a use or a load does.
    // Not the kernel: its deferred tools are unrelated capabilities (users,
    // imports, roles, routines, contacts groups...), not one app's workflow,
    // so one kernel tool used last turn filled the schema budget with some 85
    // tools the conversation never touched.
    const recentApps = new Set(
      [...recentTools(toolRecencyMap)]
        .filter((name) => deferredNames.has(name))
        .map(appOfSdkToolName)
        .filter((app) => app !== "kernel"),
    )
    const recentFill = canDiscover
      ? focusHeadroomFill({
          candidates: Object.keys(tools).filter(
            (name) =>
              deferredNames.has(name) &&
              !discoveredTools.has(name) &&
              recentApps.has(appOfSdkToolName(name)),
          ),
          tools: toolDefs,
          focus,
          visibleTokens: budget.toolSchemaTokens,
          cap: TURN_TOOL_SCHEMA_TOKEN_CAP,
        })
      : []
    for (const name of recentFill) {
      discoveredTools.add(name)
      discoveredAtStart.add(name)
      if (fixedListMode) speculativeTools.add(name)
    }
    const recentFillTokens = recentFill.reduce(
      (n, name) => n + estimateToolSchemaTokens(name, toolDefs[name]),
      0,
    )
    // The soft focus apps fill what room is left, and nothing more. Recorded
    // as this turn's discoveries: the thread keeps them like a search's, so
    // switching tabs back and forth does not change the tool set (and bust
    // the provider's prompt cache) on every message.
    const softFill = focusHeadroomFill({
      candidates: Object.keys(tools).filter(
        (name) =>
          deferredNames.has(name) &&
          !discoveredTools.has(name) &&
          focusApps.has(appOfSdkToolName(name)) &&
          !hardFocusApps.has(appOfSdkToolName(name)),
      ),
      tools: toolDefs,
      focus,
      visibleTokens: budget.toolSchemaTokens + recentFillTokens,
      cap: TURN_TOOL_SCHEMA_TOKEN_CAP,
    })
    for (const name of softFill) {
      discoveredTools.add(name)
      if (fixedListMode) speculativeTools.add(name)
    }
    // THE REST OF A CORE-LISTED FOCUS APP: loaded for the SDK and listed by
    // name and purpose (isIndexOnly), so a first call with fitting arguments
    // runs through kernel__call_tool and the schema follows when asked for.
    // They cost an index line, not a schema, so they come after the budget.
    // Without a fixed list there is no index: they stay in the deferred
    // catalog, announced and one tool_search away.
    if (fixedListMode) {
      for (const name of focusPlan.indexOnly) {
        if (discoveredTools.has(name)) continue
        discoveredTools.add(name)
        discoveredAtStart.add(name)
        speculativeTools.add(name)
        focusIndexed.add(name)
      }
    }
    if (recentFill.length > 0) {
      log.info(
        {
          orgId,
          threadId,
          recentApps: [...recentApps].sort(),
          recentFillToolCount: recentFill.length,
        },
        "Loaded more tools of the apps the last turns worked",
      )
    }
    if (focusApps.size > 0) {
      log.info(
        {
          orgId,
          threadId,
          focusApps: [...focusApps],
          hardFocusApps: [...hardFocusApps],
          preloadedToolCount: preloaded.filter((n) => discoveredTools.has(n)).length,
          indexedFocusToolCount: focusIndexed.size,
          trimmedFocusToolCount: overflow.length,
          headroomToolCount: softFill.length,
        },
        "Loaded the tools of the apps this turn is about",
      )
    }
  }
  // Capability summary + deferred catalog reflect the PROVIDER-visible surface.
  const activeAtStart = computeActiveTools()
  // A TOOL LOADED MID-TURN JOINS AT THE END. The provider sees the tools in the
  // order of this object (the SDK filters it by `activeTools`), and a prompt
  // cache reads only as far as the request repeats the previous one. Sorted by
  // name, a tool a step loads lands in the middle of the list, so everything
  // after it (the rest of the list and, on templates that render tools first,
  // the whole conversation) is billed again. The turn's starting surface goes
  // first, so a later load only appends.
  // The thread's own order (the tools the last turn sent, in its order) keeps
  // the next turn's list where the last one ended.
  orderStartingToolsFirst(tools, new Set(activeAtStart), threadToolOrder)
  // THE TOOL LIST THE PROVIDER SEES, for the whole thread. Its first turn
  // sends what it starts with; every later turn sends the list the last one
  // sent (still held), plus a core tool new to the thread at its end. A tool
  // loaded since (a search, a focus app, a recent app's fill) is loaded for
  // the SDK but left out of the list: a tool added to the list re-bills,
  // on upstreams that render the tools ahead of the conversation, the whole
  // conversation after it. Its schema rides a guide note instead
  // (takeGuideNote), and the model calls it through kernel__call_tool.
  const fixedToolList: Set<string> | null = fixedListMode
    ? (() => {
        // A tool listed by name only is not on the list: it is called through
        // kernel__call_tool, and listing it would send its schema after all.
        const startSet = new Set(activeAtStart.filter((name) => !focusIndexed.has(name)))
        if (threadToolOrder.length === 0) return startSet
        const ordered = new Set(threadToolOrder)
        return new Set([
          ...threadToolOrder.filter((name) => startSet.has(name)),
          ...activeAtStart.filter((name) => !deferredNames.has(name) && !ordered.has(name)),
        ])
      })()
    : null
  // The loaded tools the model asked for this turn (a search naming them, a
  // call): a tool loaded by name only gets its schema in the next note.
  const requestedSchemas = new Set<string>()
  if (fixedToolList) {
    runFrame.fixedToolList = fixedToolListFrame(
      fixedToolList,
      tools,
      (name) => name in tools && (!deferredNames.has(name) || discoveredTools.has(name)),
      (names) => {
        for (const name of names) requestedSchemas.add(name)
      },
    )
  }
  // The tools sent so far, in the order sent: a tool a step loads is moved to
  // the end of the list before it is first sent (prepareStep).
  const sentTools = new Set(computeActiveTools())
  // The apps of the tools every turn holds (not the ones this thread loaded,
  // which change from turn to turn): the system prompt names them.
  const appNames = [
    ...new Set(
      Object.keys(tools)
        .filter((name) => !deferredNames.has(name))
        .map(appOfSdkToolName),
    ),
  ].sort()

  // 5.5 AUTO RECALL (spec-memory.md L3), the ONE pre turn insertion point. It
  // runs before the context is assembled and after the acting agent and the
  // effective scope are known, because it reads only rows within THIS turn's
  // scope. It is skipped on a tainted thread inside `autoRecall` itself, like
  // the flush, and it never throws: a failed recall costs the turn its memory,
  // never its answer. A routine tick recalls its own prior episodes first.
  // THE QUERY IS THE TRIGGERING MESSAGE, whoever wrote it into the thread. A
  // turn started from an existing message (every mention, every DM reply, every
  // routine tick) arrives with `content` empty, since the row was written
  // before this call: recall then had nothing to search on and silently
  // returned no hits on the paths that need it most.
  //
  // NOT ON A COLD TURN (P4c-G2). A cold resume has its own recall, run inside
  // `assembleContext` against the reconstructed conversation and budgeted with
  // it (P4c-T25), and that is the block the prompt actually carries. Running
  // this one as well bought the turn a second vector search whose result was
  // then dropped: latency and tokens spent on nothing, twice per cold turn.
  // A warm turn is unchanged, because a warm turn has no other recall.
  const recalledMemory = coldResume.cold
    ? null
    : await autoRecall({
        ...(actingAgent?.agentId ? { agentId: actingAgent.agentId } : {}),
        threadId,
        orgId,
        actor,
        scopes: runFrame.effectiveScope ?? actor.scopes,
        incomingText:
          content.trim().length > 0 ? content : await triggerMessageText(orgId, userMsgId),
        ...(params.routineId ? { isRoutineTick: true, routineId: params.routineId } : {}),
      })

  // An earlier turn of this person and agent still running here stops at its
  // next step boundary because of this message (superseded-turn.ts): wait for
  // it, bounded, so this turn's history shows it closed, not missing.
  if (visitorTurn && humanTypedTurn) {
    const waited = Date.now()
    const outcome = await waitForEarlierLiveTurn({
      threadId,
      messageId: userMsgId,
      senderId: actor.userId,
      agentId: actingAgent?.agentId ?? null,
    })
    if (outcome === "timeout") {
      log.warn(
        { threadId, orgId, waitedMs: Date.now() - waited },
        "An earlier turn of this person was still running past the wait bound: assembling without it",
      )
    } else if (outcome === "ended") {
      log.info(
        { threadId, orgId, waitedMs: Date.now() - waited },
        "Waited for the person's earlier turn to stop before assembling",
      )
    }
  }

  // The person's earlier request this message replaced, when their last turn
  // here was stopped for it (superseded-turn.ts): read beside the assembly.
  const supersededRequestPromise =
    visitorTurn && humanTypedTurn
      ? earlierSupersededRequest({
          orgId,
          threadId,
          messageId: userMsgId,
          senderId: actor.userId,
          agentId: actingAgent?.agentId ?? null,
        })
      : Promise.resolve(null)

  // A routine tick (or an anchored turn) reads history from its own trigger on.
  const anchoredHistory = Boolean(params.routineId || params.anchorHistory)
  // 6. Assemble context — includes the persisted user message from step 1 via RLS-scoped history
  const context = await assembleContext({
    threadId,
    orgId,
    actor,
    currentView,
    ...(params.clientSurface ? { clientSurface: params.clientSurface } : {}),
    appNames,
    discoveredTools,
    // The request's own apps: their anchored skills come first. Only a demo
    // visitor's own turn keeps them past the system prompt cap (its step
    // budget cannot spare a skill_read); every other turn sheds them like any
    // anchored skill, so a tab with a large playbook never grows the prompt.
    focusApps,
    keepFocusSkills: visitorTurn && !params.routineId,
    // Surfaced skill bodies arrive as a note, once per thread, not in the
    // system prompt: which skills surface follows the request, and a system
    // prompt that changes re-bills the conversation after it.
    skillBodiesAsNotes: true,
    // Earlier turns' tool calls replay with the ids the model was sent, so they
    // stay in the cached prefix; only a model that takes nothing but 9
    // character ids gets them rewritten.
    keepToolCallIds: !/mistral/i.test(`${creditCheck.model.provider} ${creditCheck.model.modelId}`),
    // A demo visitor's turn has a step budget (turn-input-budget.ts), and the
    // prompt says so, so the model plans its reads around it.
    ...(visitorTurn
      ? { stepBudget: visitorStepsPerTurn({ routine: Boolean(params.routineId) }) }
      : {}),
    // The turn's own floor and its taint accumulator, both already on the run
    // frame: every scoped row the assembler injects is filtered by THIS scope
    // and records itself here (spec-security.md D5).
    effectiveScope: runFrame.effectiveScope,
    ...(runFrame.roomPeople ? { roomPeople: runFrame.roomPeople } : {}),
    // The kernel's prompt names only tools this turn holds (held-tool-mentions.ts).
    heldTools: runFrame.turnToolNames,
    turnScopeAccumulator: runFrame.turnScopeAccumulator,
    // The acting agent, so the turn carries that agent's charter in its stable
    // prefix, the same text the composition API hands the desktop session.
    ...(actingAgent?.agentId ? { agentId: actingAgent.agentId } : {}),
    // The selected model's window, for the raw history tail budget
    // (spec-memory.md L4): the bounded load measures against it.
    contextWindow: creditCheck.model.contextWindow,
    // Routine ticks run in the routine's eternal output thread, but each tick
    // is an independent job: anchor the model-visible history at THIS tick's
    // trigger message so earlier ticks' transcripts (an unbounded, ever-growing
    // log) never re-enter the context. The supervisor's `length` re-loop passes
    // the same anchor, so a multi-turn tick keeps its own earlier turns.
    ...(anchoredHistory ? { historyFromMessageId: userMsgId } : {}),
    // A non-persisting turn answers an existing message again: its context
    // ends at that message, never at a reply written after it.
    ...(persistReply ? {} : { historyUntilMessageId: userMsgId }),
    // This turn's recall, for the ephemeral tail (P4m-T24).
    ...(recalledMemory ? { recalledMemory } : {}),
    // A colleague asked this turn a question: it is the turn's instruction.
    ...(params.coordination?.askedQuestion
      ? { askedQuestion: params.coordination.askedQuestion }
      : {}),
    // A8: a reply turn's history is its reply thread.
    ...(replyRootId ? { replyRootId } : {}),
  })
  // THE GUIDE PARTS THE MODEL ALREADY HAS: the ones the system prompt carries
  // (kernel, hot apps) and the ones the replayed history's guide notes carry
  // (guide-notes.ts). Any other part a loaded tool needs is sent once, as a
  // note: the tools the turn starts with get theirs before the first step,
  // a tool a step loads gets its own after that step (prepareStep).
  // If compaction failed and returned a fallback, use the aggressively pruned messages instead
  // of the full history assembled by assembleContext (which would be over-budget).
  const assembledMessages = (compactionFallbackMessages ?? context.messages) as Array<{
    role: string
    content: unknown
  }>
  const guidePartsDelivered = new Set<string>([
    ...context.systemGuideParts,
    ...guidePartsInMessages(assembledMessages),
  ])
  // The kernel tools whose result rule the replayed history already holds:
  // this turn's results of them carry the short form (kernel-result-hints.ts).
  runFrame.resultHintsShown = resultHintsShownIn(assembledMessages)
  // The guide notes this turn sends, stored on its reply so later turns
  // replay them where they were sent.
  const guideNotes: GuideNote[] = []
  /** The guide note for the loaded tools whose guide parts the model lacks, marking them delivered. */
  // The turn's surfaced skill bodies the history does not already hold: they
  // ride the turn's first note.
  let pendingSkillNotes = (context.skillNotes ?? []).filter(
    (note) => !guidePartsDelivered.has(skillNotePart(note.name)),
  )
  // A tool known BY NAME ONLY: loaded on speculation this turn, or listed by
  // name in an earlier turn's note (its `index:` part is in the history, its
  // schema is not), and not asked for since. Its schema and its app guide's
  // parts wait for the model to ask for it; a call made without them is
  // validated like any other and, when its arguments do not fit, answered with
  // the tool's parameters (fixedToolListRepair, call-tool.ts). A hard focus
  // app's preload is the request's own app: it keeps its schemas.
  const focusPreloaded = new Set(preloaded)
  const isIndexOnly = (name: string): boolean =>
    fixedToolList !== null &&
    !requestedSchemas.has(name) &&
    !focusPreloaded.has(name) &&
    !guidePartsDelivered.has(loadedToolPart(name)) &&
    (speculativeTools.has(name) || guidePartsDelivered.has(indexedToolPart(name)))
  // THE CONVERSATION'S NOTES BUDGET (THREAD_GUIDE_NOTES_TOKEN_CAP): what the
  // thread's replies stored, plus this turn's notes so far, against the cap,
  // after every turn whether or not the thread was compacted. A routine run's
  // history starts at its own trigger, so its notes are counted from there:
  // it is not capped by the earlier ticks'.
  const threadNotesTokens = anchoredHistory ? 0 : await getThreadNotesTokens(threadId, orgId)
  const notesBudgetLeft = (): number | null =>
    anchoredHistory
      ? null
      : THREAD_GUIDE_NOTES_TOKEN_CAP -
        threadNotesTokens -
        guideNotes.reduce((n, note) => n + noteTokens(note.content), 0)
  // Parts a note past the budget left out: not offered again this turn.
  const notesWithheld = new Set<string>()
  const takeGuideNote = (): string | null => {
    const known = new Set([...guidePartsDelivered, ...notesWithheld])
    const blocks: string[] = []
    const parts: string[] = []
    const skillBlocks = pendingSkillNotes.map((note) => note.text)
    for (const note of pendingSkillNotes) parts.push(skillNotePart(note.name))
    pendingSkillNotes = []
    // The tools whose guide the model needs: every loaded one but those known
    // by name only, whose guide parts come with their schema.
    const guidedTools = new Set([...discoveredTools].filter((name) => !isIndexOnly(name)))
    // A guide that names its tools (kernel-config, ...) arrives with the
    // first of them, like an app's guide arrives with the app's first tool.
    const guides = undeliveredGuideBlocks(orgId, guidedTools, known)
    blocks.push(...guides.blocks)
    parts.push(...guides.parts)
    // A loaded tool the thread's fixed list leaves out: its description and
    // parameters, once, so it can be called through kernel__call_tool.
    // A tool known by name only gets one index line instead.
    const {
      loaded,
      indexed,
      parts: toolParts,
    } = fixedToolList
      ? undeliveredLoadedTools(computeActiveTools(), fixedToolList, tools, known, isIndexOnly)
      : { loaded: [], indexed: [], parts: [] }
    parts.push(...toolParts)
    if (
      blocks.length === 0 &&
      loaded.length === 0 &&
      indexed.length === 0 &&
      skillBlocks.length === 0
    ) {
      return null
    }
    const toolBlocks = [
      ...(loaded.length > 0 ? [renderLoadedToolsBlock(loaded)] : []),
      ...(indexed.length > 0 ? [renderIndexedToolsBlock(indexed)] : []),
    ]
    const full = renderGuideNote(
      blocks,
      parts,
      toolBlocks.length > 0 ? toolBlocks.join("\n\n") : undefined,
      skillBlocks,
    )
    const left = notesBudgetLeft()
    if (left === null || noteTokens(full) <= left) {
      for (const part of parts) guidePartsDelivered.add(part)
      return full
    }
    // Past the budget: the tools it loads, by name only, when that fits; the
    // guides and schemas are left out (a misfit call answers with the
    // parameters, fixedToolListRepair).
    for (const part of parts) notesWithheld.add(part)
    const byName = [
      ...loaded.map((t) => ({ name: t.name, description: t.description })),
      ...indexed,
    ].filter((t) => !known.has(indexedToolPart(t.name)))
    const indexParts = byName.map((t) => indexedToolPart(t.name))
    const slim =
      byName.length > 0 ? renderGuideNote([], indexParts, renderIndexedToolsBlock(byName)) : null
    log.info(
      {
        threadId,
        orgId,
        noteTokens: noteTokens(full),
        left,
        listedByName: slim && noteTokens(slim) <= left ? byName.length : 0,
      },
      "guide_notes_over_thread_budget",
    )
    if (!slim || noteTokens(slim) > left) return null
    for (const part of indexParts) guidePartsDelivered.add(part)
    return slim
  }
  // The turn's own note goes after the person's message, before the turn's
  // runtime context (which is never replayed): the next turn's history
  // repeats it at the same place.
  const startNote = takeGuideNote()
  const contextMessages = [...assembledMessages]
  if (startNote) {
    guideNotes.push({ afterToolCallId: null, content: startNote })
    let at = contextMessages.length
    while (at > 0 && isRuntimeTailMessage(contextMessages[at - 1])) at--
    contextMessages.splice(at, 0, { role: "user", content: startNote })
  }
  // A live conversation that already changed notification settings: every step
  // carries the reminder that a new change needs its own tool call this turn
  // (settings-change-note.ts; a weak model otherwise claimed unmade changes).
  const settingsChangeNote =
    !params.background &&
    historyUsedNotificationTools(contextMessages as Array<{ role: string; content: unknown }>)
      ? [{ role: "user" as const, content: NOTIFICATION_CHANGE_NOTE }]
      : []
  // A turn that follows one this message stopped answers this message: the
  // stopped turn's tool results otherwise read as work to finish (live demo).
  const supersededRequest = await supersededRequestPromise
  const supersededWorkNote = supersededRequest
    ? [{ role: "user" as const, content: supersededEarlierWorkNote(supersededRequest) }]
    : []

  // WHAT THIS STEP'S INPUT IS MADE OF (A50 budgets). The history budget governs
  // ONE of five parts, and the other four were never measured, so a step that
  // reported 84,000 input tokens against a 48,000 token history budget read as
  // "the cap is not binding" when the cap was working and the tool schemas, the
  // system prefix and the runtime context were simply unmeasured. One line, per
  // turn, summing to the request, with the history part beside its budget.
  try {
    const activeNow = fixedToolList ?? new Set(computeActiveTools())
    const breakdown = stepInputBreakdown({
      system: context.system,
      messages: contextMessages as Array<{ role: string; content: unknown }>,
      tools: Object.fromEntries(
        Object.entries(tools).filter(([name]) => activeNow.has(name)),
      ) as Record<string, { description?: string; inputSchema?: unknown }>,
      historyBudgetTokens: historyBudget(creditCheck.model.contextWindow ?? 0),
    })
    log.info(
      {
        threadId,
        agentId: actingAgent?.agentId ?? null,
        modelId: creditCheck.model.modelId,
        systemTokens: breakdown.systemTokens,
        systemParts: breakdown.systemParts.slice(0, 8),
        toolCount: breakdown.toolCount,
        toolSchemaTokens: breakdown.toolSchemaTokens,
        runtimeContextTokens: breakdown.runtimeContextTokens,
        historyTokens: breakdown.historyTokens,
        historyBudgetTokens: breakdown.historyBudgetTokens,
        historyOverBudget: breakdown.historyTokens > breakdown.historyBudgetTokens,
        nonHistoryTokens: breakdown.nonHistoryTokens,
        totalTokens: breakdown.totalTokens,
      },
      "agent_step_input_breakdown",
    )
  } catch (err) {
    log.warn({ err, threadId }, "Could not measure this step's input breakdown")
  }

  // 7. Create AbortController for mid-step credit cutoff + timeout.
  // Also forward requestSignal so a client disconnect propagates into the model call.
  // Resolve the per-invocation budget (clamped). Absent → today's defaults.
  const { maxSteps: budgetSteps, timeoutMs } = resolveAgentBudget(params.budget)
  // A resumed turn has already spent its journaled steps (S10).
  const journaledSteps = params.resume?.steps ?? []
  const maxSteps = Math.max(1, budgetSteps - journaledSteps.length)
  const abortController = new AbortController()
  // What the turn's tools get (RunContext.turnRecord.toolSignal): it follows
  // every abort but a drain handoff's, so a write already running finishes
  // and its ledger row reaches `done` (M2).
  const toolAbort = new AbortController()
  abortController.signal.addEventListener(
    "abort",
    () => {
      if (abortController.signal.reason !== DRAIN_HANDOFF_REASON) {
        toolAbort.abort(abortController.signal.reason)
      }
    },
    { once: true },
  )
  // An explicit budget (a routine, a sub-agent) keeps one wall-clock limit;
  // any other turn is stopped only when a step makes no progress, or at the
  // absolute ceiling (turn-deadline.ts). Either stops with reason "timeout".
  const turnDeadline: TurnDeadline =
    params.budget?.timeoutMs === undefined
      ? createTurnDeadline({
          mode: "progress",
          limitMs: defaultTurnDeadline.stepMs,
          ceilingMs: defaultTurnDeadline.ceilingMs,
          onExpire: () => abortController.abort("timeout"),
        })
      : createTurnDeadline({
          mode: "wall",
          limitMs: timeoutMs,
          onExpire: () => abortController.abort("timeout"),
        })
  // Why the visitor spend gate stopped this turn, in the visitor's words.
  const turnDemoRefusal = async (): Promise<{ code: DemoSpendCode; text: string } | null> => {
    const code = creditCheck.demo?.refusal
    if (!code) return null
    const { locale } = await loadDemoOrg(orgId)
    return { code, text: demoSpendMessage(code, locale) }
  }
  if (requestSignal) {
    if (requestSignal.aborted) {
      abortController.abort(requestSignal.reason)
    } else {
      requestSignal.addEventListener("abort", () => abortController.abort(requestSignal.reason), {
        once: true,
      })
    }
  }

  // 8. Call streamText — context.messages already ends with the user's message;
  //    do NOT append content again to avoid sending the same user turn twice.
  //    Delegates to `runAgentStream` so the subrun worker can share the loop.
  let cumulativeUncachedInputTokens = 0
  let tokenWarnLogged = false
  // Set by the hard-token-limit stop condition when it ends the loop.
  let stoppedAtHardTokenLimit = false
  // A person's chat turn has an input budget (turn-input-budget.ts): past it,
  // the next step checks in with the person instead of calling more tools. A
  // routine tick has its own limit, and a turn another agent started answers
  // that agent, so neither is budgeted here.
  // A demo visitor's turn, whoever started it, also has a step budget: its
  // last step answers with tools off (a live chat turn kept creating tasks well
  // after it had done what it was asked, every step on the visitor's budget).
  // A routine run has its own, larger step limit (visitorStepsPerTurn); the meter that bills
  // the box key counts to the same number.
  const visitorStepBudget = visitorTurn
    ? visitorStepsPerTurn({ routine: Boolean(params.routineId) })
    : null
  if (visitorStepBudget !== null && creditCheck.demo) creditCheck.demo.maxSteps = visitorStepBudget
  // A visitor's own request, typed or sent from a tour, running in the
  // background (a streamed turn already ends when its client goes): a newer
  // one replaces it.
  const supersedable = visitorTurn && humanTypedTurn && !requestSignal
  const turnBudget =
    visitorStepBudget !== null
      ? createTurnInputBudget({ maxSteps: visitorStepBudget })
      : params.background || params.routineId || params.coordination || params.agentDispatched
        ? null
        : createTurnInputBudget()
  // Every step of the turn, whichever stream ran it (the turn's own, a
  // correction continuation, an earlier attempt of a resumed turn): the
  // check-in answers from all of them (checkInFacts).
  const turnSteps: Array<NonNullable<Parameters<typeof checkInFacts>[0]>[number]> = []
  // Run-scoped clip-once ledger for intra-run micro-compaction (prepareStep).
  const clippedResultIds: ClipLedger = new Map()
  // A repeat fetch pins the earlier result through it (web-fetch-repeat.ts).
  runFrame.clipLedger = clippedResultIds
  // Did the previous step's `messages` override carry a per-step tail (mail,
  // guide, skills)? AI SDK 7 carries an override forward, so the next step
  // must override again to drop it (prepareStep below).
  let injectedLastStep = false
  // The step budget's last-tool-step note, delivered once (prepareStep).
  let lastToolStepNoted = false
  // Skills already delivered mid-turn (prepareStep), once each.
  // The guide notes sent after a step, each at the place in the SDK's response
  // messages where it was sent (prepareStep keeps it there).
  const midTurnGuideMessages: Array<{ at: number; message: { role: "user"; content: string } }> = []
  const midTurnSkillsDelivered = new Set<string>()
  const rollingCache = creditCheck.model.provider === "anthropic"
  // A turn that starts with the routine's hard token limit already spent (by an
  // earlier turn of the tick, or a sub-run in another worker) makes no model
  // call at all: a no-call model ends the loop at once, and finalize writes the
  // stop text as this turn's output through the ordinary persistence path.
  let spentBeforeFirstStep = false
  if (tokenAccount?.hardTokenLimit != null) {
    await refreshTokenAccount(tokenAccount)
    spentBeforeFirstStep = hardTokenLimitReached(tokenAccount)
    if (spentBeforeFirstStep) stoppedAtHardTokenLimit = true
  }
  // A ROUTINE run waits for its gated calls (routine-run-resume.ts): once the
  // pause falls due (`routinePauseFallsDue`: a parked call it cannot chain on,
  // or other work after one), the next step says what the run waits for, tools
  // off, and the loop stops after it. The run resumes with the real result once
  // the call is decided, so nothing after the pause guesses it.
  // Steps this turn has finished (the agent_step_usage line).
  let stepsFinished = 0
  let routinePauseDue = false
  let routineParkedEarlier = false
  let routineChainRetries = ROUTINE_CHAIN_RETRIES
  let routinePauseSent = false
  // ---- The durable turn (S10): resume seed, journal, open ----
  // Set by a draining process at its turn cap: the loop stops after the
  // current step, and finalize hands the turn off instead of persisting.
  let handoffRequested = false
  // The journaled response messages before this attempt: a mid-turn guide
  // note's place is journaled against ALL of the turn's responses.
  const journaledMessages = journaledSteps.flatMap((step) => step.messages)
  const priorPrep: JournalPrepState | undefined = journaledSteps[journaledSteps.length - 1]?.prep
  const priorGuideMessages = priorPrep?.midTurnGuideMessages ?? []
  if (params.resume && priorPrep) {
    // The state the next step depends on, as the last complete step left it.
    // Restored after the turn's start note was taken from the start state, so
    // the rebuilt initial messages equal the first attempt's.
    for (const name of priorPrep.discoveredTools) discoveredTools.add(name)
    guidePartsDelivered.clear()
    for (const part of priorPrep.guidePartsDelivered) guidePartsDelivered.add(part)
    for (const name of priorPrep.requestedSchemas ?? []) requestedSchemas.add(name)
    for (const name of resultHintsShownIn(journaledMessages)) runFrame.resultHintsShown?.add(name)
    guideNotes.splice(0, guideNotes.length, ...priorPrep.guideNotes)
    for (const name of priorPrep.midTurnSkillsDelivered) midTurnSkillsDelivered.add(name)
    for (const [id, output] of priorPrep.clippedResultIds) {
      clippedResultIds.set(id, output as Parameters<ClipLedger["set"]>[1])
    }
    const accumulator = runFrame.turnScopeAccumulator
    accumulator.recordInstructions(priorPrep.scopes)
    if (priorPrep.readInternalData) accumulator.markInternalRead()
    for (const [table, ids] of Object.entries(priorPrep.originRows)) {
      accumulator.recordOriginRows(table, ids)
    }
    for (const id of priorPrep.taintedToolCallIds) runFrame.taintedToolCallIds.add(id)
    // The tools sent so far keep their order: the ones a step loaded go last.
    const loadedLater = priorPrep.sentTools.filter((name) => !sentTools.has(name))
    moveToolsToEnd(tools, loadedLater)
    for (const name of loadedLater) sentTools.add(name)
  }
  if (params.resume) {
    // The complete steps, exactly as the SDK produced them, after the turn's
    // initial messages, with their guide notes where they were sent. The
    // runtime tail stays last, as the uninterrupted turn's later steps keep it
    // (prepareStep below): the resumed request then equals that turn's request
    // at the same step, and its cached prefix still matches. An anchored
    // history (a routine tick) keeps its tail where it was sent, as live.
    let tailAt = contextMessages.length
    if (!anchoredHistory) {
      while (tailAt > 0 && isRuntimeTailMessage(contextMessages[tailAt - 1])) tailAt--
    }
    contextMessages.splice(
      tailAt,
      0,
      ...withGuideNotes(
        journaledMessages,
        priorGuideMessages.map((note) => ({
          at: note.at,
          message: { role: "user" as const, content: note.content },
        })),
      ),
    )
  }
  // The finalize's view of the earlier attempts' steps.
  const priorViews: JournalStepView[] = journaledSteps.map((step) => step.view)
  // A resumed turn's earlier attempts took steps: they count against its
  // budget, a visitor's step cap included, so a resume never starts the count
  // again (a visitor turn handed off mid-step ran up to twice its cap), and the
  // check-in lists their calls with this attempt's.
  for (const view of priorViews) {
    turnBudget?.recordStep(view.usage.inputTokens)
    turnSteps.push({
      toolCalls: view.toolCalls.map((c) => ({
        toolName: c.toolName,
        toolCallId: c.toolCallId,
        input: c.args,
      })),
      toolResults: view.toolResults.map((r) => ({ toolCallId: r.toolCallId, output: r.result })),
    })
  }
  if (visitorStepBudget !== null && creditCheck.demo && priorViews.length > 0) {
    creditCheck.demo.maxSteps = Math.max(1, visitorStepBudget - priorViews.length)
  }
  let stepsJournaled = params.resume?.turn.stepCount ?? 0
  const effectKeysSeed = priorPrep?.effectKeys ?? {}
  // The journal stores each step's ADDITIONS to the growing prepareStep state
  // (clips, guide notes), not the whole state again (M7): parseJournal folds
  // them back. What the journal already holds, by identity:
  const journaledClips = new Map<string, unknown>(clippedResultIds)
  let guideMessagesJournaled = 0
  // Tool names by call id, for redacting a clipped result (H3).
  const toolNameById = new Map<string, string>()
  const learnToolNames = (list: ReadonlyArray<{ content: unknown }>) => {
    for (const message of list) {
      if (!Array.isArray(message.content)) continue
      for (const part of message.content as Array<Record<string, unknown>>) {
        if (
          (part?.type === "tool-result" || part?.type === "tool-call") &&
          typeof part.toolCallId === "string" &&
          typeof part.toolName === "string"
        ) {
          toolNameById.set(part.toolCallId, part.toolName)
        }
      }
    }
  }
  learnToolNames(journaledMessages)

  const journalStep = async (step: unknown): Promise<"ok" | "fenced"> => {
    const rec = runFrame.turnRecord
    if (!rec) return "ok"
    const response = (step as { response?: { messages?: unknown } } | undefined)?.response
    const raw = Array.isArray(response?.messages)
      ? (response.messages as Array<{ role: string; content: unknown }>)
      : []
    learnToolNames(raw)
    const { messages: stepMessages, redacted } = await redactStepMessages(orgId, raw)
    // A clip is the head of a RAW tool result: it is redacted exactly as the
    // result itself is (Invariant K, H3). A clip whose tool is unknown is not
    // journaled at all (fail closed): a resume clips that result again from
    // the journaled, redacted messages.
    const clipDelta: Array<[string, unknown]> = []
    const clipsSeen: Array<[string, unknown]> = []
    for (const [id, output] of clippedResultIds) {
      if (journaledClips.has(id) && journaledClips.get(id) === output) continue
      clipsSeen.push([id, output])
      if (!output) {
        clipDelta.push([id, null])
        continue
      }
      const toolName = toolNameById.get(id)
      if (!toolName) continue
      const value = await redactMailToolResult(orgId, toolName, output.value)
      clipDelta.push([id, value === output.value ? output : { ...output, value }])
    }
    const guideDelta = midTurnGuideMessages.slice(guideMessagesJournaled)
    const accumulator = runFrame.turnScopeAccumulator
    const prep: JournalPrepState = {
      discoveredTools: [...discoveredTools].sort(),
      sentTools: [...sentTools],
      guidePartsDelivered: [...guidePartsDelivered],
      requestedSchemas: [...requestedSchemas].sort(),
      guideNotes: guideNotes.map((note) => ({ ...note })),
      midTurnGuideMessages: guideDelta.map((note) => ({
        at: note.at + journaledMessages.length,
        content: note.message.content,
      })),
      midTurnSkillsDelivered: [...midTurnSkillsDelivered],
      clippedResultIds: clipDelta,
      effectKeys: rec.effectKeys.snapshot(),
      scopes: accumulator.snapshot(),
      readInternalData: accumulator.readInternalData(),
      originRows: accumulator.originRows(),
      taintedToolCallIds: [...runFrame.taintedToolCallIds],
    }
    const payload: JournalStep = {
      stepIndex: stepsJournaled + 1,
      messages: stepMessages,
      redacted,
      view: await stepView(orgId, step),
      prep,
    }
    const outcome = await appendStep(orgId, rec.turnId, rec.runner, journalPayload(payload))
    if (outcome === "ok") {
      stepsJournaled++
      for (const [id, output] of clipsSeen) journaledClips.set(id, output)
      guideMessagesJournaled += guideDelta.length
    }
    return outcome
  }

  // Everything that restricts this turn, so a resume re-applies it (S10, H1).
  const turnRestrictions = (): AgentTurnRestrictions => {
    const coordination = params.coordination
    return {
      ...(coordination
        ? {
            coordination: {
              callerAgentId: coordination.callerAgentId,
              parentMessageId: coordination.parentMessageId,
              ...(coordination.delegatedScope
                ? { delegatedScope: [...coordination.delegatedScope] }
                : {}),
              ...(coordination.callerTaintScopes
                ? { callerTaintScopes: [...coordination.callerTaintScopes] }
                : {}),
              ...(coordination.askedQuestion
                ? { askedQuestion: { ...coordination.askedQuestion } }
                : {}),
            },
          }
        : {}),
      ...(params.sessionRestricted ? { sessionRestricted: true } : {}),
      ...(params.agentDispatched ? { agentDispatched: true } : {}),
      ...(params.anchorHistory ? { anchorHistory: true } : {}),
      ...(params.askId ? { askId: params.askId } : {}),
      replyRootId: replyRootId ?? null,
      ...(currentView ? { currentView: { ...currentView } } : {}),
      dimensionGrants: actor.dimensionGrants ?? {},
      ...(runFrame.routineRunId ? { routineRunId: runFrame.routineRunId } : {}),
      ...(tokenAccount
        ? {
            tokenAccount: {
              id: tokenAccount.id,
              tokenBudget: tokenAccount.tokenBudget,
              hardTokenLimit: tokenAccount.hardTokenLimit,
            },
          }
        : {}),
    }
  }

  // What a resume rebuilds the turn from (written once, when the turn opens).
  const buildResumeInput = (): AgentTurnResumeInput => ({
    // Ids and the ceiling only: a resume re-reads the actor's current
    // permissions and never runs wider than this (M11).
    actor: {
      userId: actor.userId,
      scopes: actor.scopes ?? [],
      ...(runFrame.effectiveScope ? { effectiveScope: runFrame.effectiveScope } : {}),
    },
    actingAgentId: actingAgent?.agentId ?? null,
    // The model and reasoning level the turn RUNS on (an Auto pick
    // resolved), not the ones asked for: a resume continues on them, so its
    // journaled provider metadata (reasoning signatures) goes back to the
    // provider that wrote it, with the same request shape (C2).
    modelId: creditCheck.model.modelId,
    reasoningLevel: effectiveReasoningLevel,
    background: params.background ?? false,
    routineId: params.routineId ?? null,
    maxSteps: budgetSteps,
    clientSurface: params.clientSurface ?? null,
    liveTurnKey: params.liveTurnId ?? null,
    toolNames: Object.keys(tools),
    systemPromptHash: crypto
      .createHash("sha256")
      .update(JSON.stringify(context.system))
      .digest("hex"),
    // A turn whose caller holds its reply (Share anyway) cannot be
    // rebuilt elsewhere: it is never resumed (H1).
    ...(persistReply && !params.readOnlyTools && !params.scopeOverride ? {} : { resumable: false }),
    startScopes: runFrame.turnScopeAccumulator.snapshot(),
    restrictions: turnRestrictions(),
  })

  // Which attempt of the turn this run is (turn-ledger `attempt`): a provider
  // failure mid-step re-runs the turn only while attempts remain (onProviderFailure).
  let turnAttempt = 0
  const openDurableTurn = async (): Promise<TurnRecordHandle> => {
    const handle = (turnId: string): TurnRecordHandle => ({
      turnId,
      orgId,
      runner: INSTANCE_ID,
      effectKeys: new TurnEffectKeys(turnId, effectKeysSeed),
      fenced: false,
      toolSignal: toolAbort.signal,
    })
    if (params.resume) {
      turnAttempt = params.resume.turn.attempt
      return handle(params.resume.turn.id)
    }
    const resumeInput = buildResumeInput()
    if (params.retryTurn) {
      const reopened = await reopenForRetry({
        orgId,
        turnId: params.retryTurn.id,
        expectedAttempt: params.retryTurn.attempt,
        resumeInput,
        userMessageId: userMsgId,
        runId: rootRunId,
      })
      if (!reopened) {
        throw new HTTPException(409, { message: `turn ${params.retryTurn.id} was re-run already` })
      }
      turnAttempt = reopened.attempt
      return handle(reopened.id)
    }
    const { turn, created } = await openTurn({
      orgId,
      threadId,
      origin: params.origin ?? (skipUserPersist ? "thread" : "chat"),
      originRef: params.originRef ?? null,
      agentId: actingAgent?.agentId ?? null,
      userMessageId: userMsgId,
      runId: rootRunId,
      resumeInput,
    })
    if (!created) {
      // The caller checks the origin first (invokeAgentForThread); meeting a
      // turn here is a concurrent re-run of the same job.
      throw new HTTPException(409, { message: `turn for ${params.originRef} already exists` })
    }
    turnAttempt = turn.attempt
    return handle(turn.id)
  }

  const stopConditions = (stepCap: number): Array<StopCondition<ToolSet>> => [
    isStepCount(stepCap),
    ...(tokenAccount?.hardTokenLimit != null
      ? [
          async () => {
            // Sub-runs in other workers add to the shared counter: read it.
            await refreshTokenAccount(tokenAccount)
            if (!hardTokenLimitReached(tokenAccount)) return false
            stoppedAtHardTokenLimit = true
            return true
          },
        ]
      : []),
    ...(turnBudget ? [() => turnBudget.checkInSent] : []),
    // A step budget (a visitor's turn) is a hard cap on the whole turn,
    // whichever stream reaches it.
    ...(turnBudget ? [() => turnBudget.stepsLeft() === 0] : []),
    ...(params.routineId ? [() => routinePauseSent] : []),
    // A draining process stops the turn at the next step boundary (M2).
    () => handoffRequested,
  ]
  const stepTimer = new StepTimer()
  const streamParams: RunAgentStreamParams = {
    model: spentBeforeFirstStep
      ? (hardLimitNoCallModel(creditCheck.model.modelId) as never)
      : model,
    stepTokenCap: creditCheck.model.stepTokenCap ?? null,
    stepTimer,
    system: context.system,
    messages: contextMessages as Array<{ role: string; content: unknown }>,
    tools,
    // Background ticks ride out per-minute provider quota windows instead of
    // failing after the SDK's 3 fast attempts (see RunAgentStreamParams).
    ...(params.background ? { maxRetries: BACKGROUND_MAX_RETRIES } : {}),
    repairToolCall: fixedToolListRepair(blindCallRepair(tools), fixedToolList),
    fixedToolList,
    // Per-step provider-visible surface: core + discovered tools, recomputed
    // every step so a tool_search discovery in step N is callable in step N+1.
    // The same hook delivers the full instruction block of any app discovered
    // MID-RUN (assembly only carried a one-line summary for it); later turns
    // include it via assembleContext since discoveries persist per thread.
    //
    // CACHE DISCIPLINE: the guide rides as a runtime-context message APPENDED
    // to the step's message tail, NEVER as a system-prefix mutation. Providers
    // prefix-cache byte-for-byte from position 0, so growing `system` mid-run
    // invalidated the ENTIRE cached prefix (system + full history) on every
    // discovery — measured as a ~74% cache-miss rate on a routine tick.
    // Discovery is conversational: the schema arrives via the tool_search
    // result, the app guide arrives here at the tail; only the tool CATALOG
    // change itself (activeTools growth, required for callability) still costs
    // one prefix re-read at the moment of discovery.
    // The same hook also runs intra-run micro-compaction: tool results older
    // than the keep-window are clipped once to the replay cap (see
    // stale-result-clipper.ts) so a 48k-char result from step 2 doesn't ride
    // verbatim through 38 more steps — the dominant uncached-token sink.
    prepareStep: (options: unknown) => {
      type StepMessage = { role: string; content: unknown }
      const step = options as
        | {
            messages?: StepMessage[]
            initialMessages?: StepMessage[]
            responseMessages?: StepMessage[]
          }
        | undefined
      // A tool loaded since the last step joins the END of the list, whatever
      // its name, so every earlier tool keeps its place in the request.
      const newlyActive = computeActiveTools().filter((name) => !sentTools.has(name))
      if (newlyActive.length > 0) {
        moveToolsToEnd(tools, newlyActive)
        for (const name of newlyActive) sentTools.add(name)
      }
      // A tool the last steps called is one the model asked for: if it was
      // known by name only, its schema and guide parts join the next note.
      for (const called of (options as { steps?: MidTurnSteps } | undefined)?.steps ?? []) {
        for (const call of called.toolCalls ?? []) {
          if (call.toolName) requestedSchemas.add(call.toolName)
        }
      }
      // The guide parts a tool this step loaded needs, delivered ONCE, right
      // after the step that loaded it, and kept there for the rest of the turn
      // and in the history of later turns (guide-notes.ts).
      const stepGuideNote = takeGuideNote()
      // The turn has sent its budget: this step answers, tools off, and the
      // loop stops after it (stopWhen below).
      const checkIn = turnBudget?.checkInDue() === true
      if (checkIn) {
        turnBudget?.markCheckInSent()
        log.info(
          {
            threadId,
            orgId,
            used: turnBudget?.used,
            limit: turnBudget?.limit,
            maxSteps: visitorStepBudget,
            reason:
              turnBudget?.limit != null && (turnBudget?.used ?? 0) >= turnBudget.limit
                ? "input budget"
                : "step budget",
          },
          "Turn reached its budget: this step checks in with the person, tools off",
        )
      }
      const routinePause = !checkIn && routinePauseDue && !routinePauseSent
      if (routinePause) routinePauseSent = true
      // THE ANSWER STEP KEEPS ITS TOOLS. With `toolChoice: "none"` the live
      // upstreams dropped the tool list from the prompt (the step's input fell
      // by the schemas' size and its cache read fell to about 2k tokens), and
      // OpenRouter routed some of those steps to another upstream. The step
      // sends the same tools as the step before; its note says to answer in
      // words, and a call it makes anyway is not run (StepContext).
      stepCtx.answerOnly = checkIn
        ? TURN_BUDGET_ANSWER_ONLY_RESULT
        : routinePause
          ? ROUTINE_RUN_PAUSE_ANSWER_ONLY_RESULT
          : null
      // A routine run chaining on a parked call proposes steps only: same
      // tools, but a call that would run at once is refused (StepContext).
      stepCtx.chainOnly =
        params.routineId && !runFrame.routineFollowUp && routineParkedEarlier && !routinePauseDue
          ? ROUTINE_CHAIN_ONLY_RESULT
          : null
      const base = { activeTools: computeActiveTools() }
      // A step budget's last step with tools says so, once: the writes the
      // request asks for go out now, not after another round of reading.
      const lastToolStep = !checkIn && !lastToolStepNoted && turnBudget?.lastToolStepDue() === true
      if (lastToolStep) lastToolStepNoted = true
      // The check-in answers from the turn's own record: what ran, what waits, nothing else.
      const checkInMessages = checkIn
        ? [
            {
              role: "user" as const,
              content: `${TURN_BUDGET_CHECK_IN_NOTE}\n${checkInFacts(turnSteps)}`,
            },
          ]
        : routinePause
          ? [{ role: "user" as const, content: ROUTINE_RUN_PAUSE_NOTE }]
          : lastToolStep
            ? [{ role: "user" as const, content: TURN_BUDGET_LAST_TOOL_STEP_NOTE }]
            : []
      // The skills anchored to an app whose first tool this turn called after assembly,
      // delivered once each, beside the app's guide (mid-turn-skills.ts).
      const midTurnSkills = context.skillSurface
        ? takeMidTurnSkills(
            context.skillSurface,
            appsCalledInSteps((options as { steps?: MidTurnSteps } | undefined)?.steps),
            midTurnSkillsDelivered,
          )
        : []
      const skillMessages =
        midTurnSkills.length > 0
          ? [{ role: "user" as const, content: renderMidTurnSkills(midTurnSkills) }]
          : []
      // A delivered body is in the turn now: it taints the turn with its scopes, as an
      // assembled one does. (Only turn-visible skills are ever anchorable.)
      // A skill is the agent's own instructions, never org data it read (readInternalData).
      for (const skill of midTurnSkills) {
        runFrame.turnScopeAccumulator.recordInstructions(skill.requiredScopes)
      }
      if (midTurnSkills.length > 0) {
        log.info(
          { threadId, midTurnSkills: midTurnSkills.map((s) => s.name) },
          "Delivered app-anchored skills for an app first used this turn",
        )
      }
      // Every injection below is for ONE step (the guide once, the mailbox
      // plaintext re-appended per step, the clips re-applied per step). Since
      // AI SDK 7 a `messages` override carries forward to later steps, so the
      // step is rebuilt from what the SDK itself accumulated (the caller's
      // messages plus every response so far), never from an earlier step's
      // override, and the rebuilt list is always returned: returning nothing
      // would let an earlier step's injections ride along.
      const responses = Array.isArray(step?.responseMessages) ? step.responseMessages : null
      // Without the SDK's own split the note cannot be kept in place: it rides
      // this step's tail, as a per-step injection.
      const tailGuideNote: Array<{ role: "user"; content: string }> = []
      if (stepGuideNote) {
        // After the tool results the note follows: the last call it answers is its place.
        guideNotes.push({
          afterToolCallId: responses ? lastToolResultCallId(responses) : null,
          content: stepGuideNote,
        })
        const message = { role: "user" as const, content: stepGuideNote }
        if (responses) midTurnGuideMessages.push({ at: responses.length, message })
        else tailGuideNote.push(message)
      }
      // THE TURN'S RUNTIME TAIL STAYS LAST. It is never replayed, so where it
      // sat between the person's message and the first step, the next turn's
      // history stopped matching there and re-read every step of this turn.
      // After the steps, a step re-reads only the tail itself, and the next
      // turn repeats this turn's last request up to it. It rides with the
      // per-step injections, after the rolling cache breakpoint.
      // A routine tick's history starts at its own trigger (historyFromMessageId):
      // no later tick replays this one's steps, so its tail stays where it
      // was sent, read once from the cache instead of again on every step.
      const initial = Array.isArray(step?.initialMessages) ? step.initialMessages : null
      let tailAt = initial ? initial.length : 0
      while (initial && tailAt > 0 && isRuntimeTailMessage(initial[tailAt - 1])) tailAt--
      // A resumed turn's journaled steps are already in `initial`, before its
      // tail: they count as steps taken, as the uninterrupted turn's would.
      const runtimeTail =
        initial && responses && responses.length + journaledMessages.length > 0 && !anchoredHistory
          ? initial.slice(tailAt)
          : []
      const stepMessages =
        initial && responses
          ? [
              ...(runtimeTail.length > 0 ? initial.slice(0, tailAt) : initial),
              ...withGuideNotes(responses, midTurnGuideMessages),
            ]
          : step?.messages
      if (!Array.isArray(stepMessages)) return base
      // Stale results clipped, then the rolling cache breakpoints placed on the
      // clipped list, before the per-step injections below: those are gone or
      // moved by the next step (rolling-cache-breakpoints.ts). Anthropic only.
      const stepList = clipAndMarkStepMessages(stepMessages, clippedResultIds, rollingCache)
      // Mail decrypted by the user's own browser for THIS turn (blueprint Task
      // 9.2). It rides as a message appended to the step tail and NOWHERE else:
      // it is not a tool result, so `extractToolCalls` never sees it and it
      // cannot reach `kernel.messages.metadata`. It is re-appended each step
      // because the SDK's own message list never contains it, and it is dropped
      // when the turn finalizes.
      const mailboxBlocks = getEphemeralMailboxContext(rootRunId)
      const mailboxMessages = [
        ...mailboxBlocks.map((content) => ({
          role: "user" as const,
          content,
        })),
        // Not mail, but the same kind of per-step tail notes.
        ...settingsChangeNote,
        ...supersededWorkNote,
      ]
      const injected = [
        ...runtimeTail,
        ...mailboxMessages,
        ...tailGuideNote,
        ...skillMessages,
        ...checkInMessages,
      ]
      // Nothing to add, nothing clipped, no guide note in the list and no
      // earlier step's per-step tail to drop: the SDK's own list is already
      // this step's list.
      if (
        injected.length === 0 &&
        stepList === stepMessages &&
        midTurnGuideMessages.length === 0 &&
        !injectedLastStep
      ) {
        return base
      }
      injectedLastStep = injected.length > 0
      return { ...base, messages: [...stepList, ...injected] }
    },
    providerOptions: reasoningPlan.providerOptions,
    // The routine's hard token limit (S17) stops the loop between steps once
    // the run's shared account reaches it. The SDK awaits onStepFinish (which
    // adds the step's tokens) before it evaluates the stop conditions. A run
    // with no limit keeps the step count alone, exactly as before.
    // An interactive turn also stops after its budget check-in step, whatever
    // that step did (a call written out as text is still turned into one).
    stopWhen: stopConditions(maxSteps),
    onStepFinish: async (step) => {
      // A completed step is progress: a progress deadline restarts its clock.
      turnDeadline.stepCompleted()
      // ONE LINE PER STEP: what the step sent, what the provider served from its
      // cache, and which upstream served it. The per-turn cache_hit_ratio line
      // sums the steps, so it cannot say which step re-read the prompt in full
      // (a prefix that moved, a new upstream) or how many steps a turn took.
      {
        const usage = readStepUsage((step as { usage?: unknown } | undefined)?.usage)
        const meta = (step as { providerMetadata?: unknown } | undefined)?.providerMetadata
        const times = stepTimer.stepFinished()
        const upstream = readUpstreamProvider(meta) ?? null
        const tokensPerSecond =
          times.ttftMs !== null && times.modelMs !== null
            ? stepTokensPerSecond(usage.outputTokens, times.ttftMs, times.modelMs)
            : null
        // A host's measured speed decides where new threads start (openrouter-host-speed.ts).
        if (
          creditCheck.model.provider === "openrouter" &&
          upstream &&
          times.ttftMs !== null &&
          creditCheck.model.upstreamId
        ) {
          defaultHostSpeedSource.record(creditCheck.model.upstreamId, upstream, {
            ttftMs: times.ttftMs,
            tps: tokensPerSecond,
          })
        }
        stepsFinished++
        log.info(
          {
            threadId,
            orgId,
            modelId: creditCheck.model.modelId,
            step: stepsFinished,
            inputTokens: usage.inputTokens ?? null,
            cacheReadTokens: usage.cacheReadTokens,
            outputTokens: usage.outputTokens ?? null,
            toolCalls: (step as { toolCalls?: unknown[] } | undefined)?.toolCalls?.length ?? 0,
            upstream,
            costUsd: readProviderCostUsd(meta) ?? null,
            ttftMs: times.ttftMs,
            modelMs: times.modelMs,
            stepMs: times.stepMs,
            tokensPerSecond,
          },
          "agent_step_usage",
        )
      }
      // THE STEP IS COMPLETE: journal it (S10, C2) before anything may stop
      // the turn, so a resume continues after it. Fenced = another process
      // owns the turn now: stop, persist nothing.
      // A step the provider broke off (an in-band error part ends it with
      // `finishReason: "error"`) is not complete: the re-run issues it again,
      // so it must not be replayed as a step that happened.
      const stepBrokenOff =
        (step as { finishReason?: unknown } | undefined)?.finishReason === "error" ||
        streamRetryDelayMs !== null
      if (!turnRecord.fenced && !stepBrokenOff) {
        const journaled = await journalStep(step).catch((err: unknown) => {
          // A journal write that fails is not a fence: the turn goes on, and
          // a resume would re-issue this step (its writes are on the ledger).
          log.error({ err, threadId, turnId: turnRecord.turnId }, "turn_journal_failed")
          return "ok" as const
        })
        if (journaled === "fenced") {
          turnRecord.fenced = true
          abortController.abort(FENCED_REASON)
          return
        }
      }
      // A follow-up routine never pauses: what it staged waits for a person
      // while the run goes on and ends (routine-run-resume.ts).
      if (params.routineId && !runFrame.routineFollowUp && !routinePauseDue) {
        if (routinePauseFallsDue(step, routineParkedEarlier, routineChainRetries)) {
          routinePauseDue = true
        } else if (routineParkedEarlier && !stepParkedACall(step)) {
          routineChainRetries--
        }
        if (stepParkedACall(step)) routineParkedEarlier = true
      }
      if (tokenAccount) {
        await recordStepTokens(
          tokenAccount,
          stepTokens((step as { usage?: unknown } | undefined)?.usage),
        )
      }
      turnBudget?.recordStep(
        readStepUsage((step as { usage?: unknown } | undefined)?.usage).inputTokens ?? 0,
      )
      {
        const done = step as {
          toolCalls?: Array<{ toolName?: string; toolCallId?: string; input?: unknown }>
          toolResults?: Array<{ toolCallId?: string; output?: unknown }>
        }
        turnSteps.push({ toolCalls: done.toolCalls ?? [], toolResults: done.toolResults ?? [] })
      }
      // Runaway guard: cumulative input tokens across this run's steps. Checked
      // here (not in the chunk loop) so the abort fires between steps — the
      // model never starts another full-context step past the cap.
      cumulativeUncachedInputTokens += uncachedInputTokens(
        (step as { usage?: unknown } | undefined)?.usage,
      )
      const guard = runawayGuardDecision(cumulativeUncachedInputTokens, tokenWarnLogged)
      if (guard === "warn") {
        tokenWarnLogged = true
        log.warn(
          { threadId, orgId, cumulativeUncachedInputTokens, routineId: params.routineId },
          "Agent run passed the uncached-input-token warn threshold — runaway suspect",
        )
      } else if (guard === "abort") {
        log.error(
          {
            threadId,
            orgId,
            cumulativeUncachedInputTokens,
            cap: AGENT_RUN_INPUT_TOKEN_CAP,
            routineId: params.routineId,
          },
          "Agent run exceeded the hard uncached-input-token cap — aborting as a runaway (this is a bug to investigate, not normal load)",
        )
        abortController.abort("token_budget_exceeded")
        return
      }
      const midCheck = await checkMidStep(orgId, creditCheck.keySource)
      if (midCheck.exhausted) {
        abortController.abort("credits_exhausted")
      }
      // A demo visitor's turn that a newer request of theirs replaced stops
      // here, before its next model call (superseded-turn.ts).
      if (
        supersedable &&
        !abortController.signal.aborted &&
        turnBudget?.checkInSent !== true &&
        (await turnSupersededByNewerMessage({
          orgId,
          threadId,
          messageId: userMsgId,
          senderId: actor.userId,
          agentId: actingAgent?.agentId ?? null,
        }))
      ) {
        log.info({ threadId, orgId }, "Visitor turn superseded by a newer message: stopping")
        abortController.abort(SUPERSEDED_FINISH_REASON)
      }
      // A visitor turn on the demo box key: settle this step (always, at
      // what it reported), and reserve the next before it may run unless the
      // turn is already stopping (a budget, the step cap or spend off ends it).
      if (creditCheck.demo) {
        // A turn whose check-in step just ran ends here: nothing to reserve.
        const stopping = abortController.signal.aborted || turnBudget?.checkInSent === true
        const next = await creditCheck.demo.stepFinished(
          (step as { usage?: unknown } | undefined)?.usage,
          (step as { providerMetadata?: unknown } | undefined)?.providerMetadata,
          { reserveNext: !stopping },
        )
        if (next.exhausted && !stopping) {
          abortController.abort("credits_exhausted")
        }
      }
    },
    abortSignal: abortController.signal,
  }
  // THE DURABLE TURN (S10): opened (or, on a resume, already claimed) as the
  // last thing before the model runs, so a turn that fails to start leaves
  // no record behind.
  const turnRecord = await openDurableTurn()
  runFrame.turnRecord = turnRecord
  // A turn a resume cannot rebuild (Share anyway) is not handed off.
  const turnResumable = persistReply && !params.readOnlyTools && !params.scopeOverride
  const unregisterTurn = registerDurableTurn({
    turnId: turnRecord.turnId,
    orgId,
    resumable: turnResumable,
    // The heartbeat moves while the turn runs, not only at step boundaries:
    // a live turn's record never looks stale (M3). A fenced touch means
    // another process owns the turn now: stop.
    touch: async () => {
      if (turnRecord.fenced) return
      const touched = await touchTurn(orgId, turnRecord.turnId, turnRecord.runner)
      if (touched === "fenced") {
        turnRecord.fenced = true
        abortController.abort(FENCED_REASON)
      }
    },
    requestHandoff: () => {
      handoffRequested = true
    },
    abortModel: () => {
      handoffRequested = true
      abortController.abort(DRAIN_HANDOFF_REASON)
    },
  })
  // A provider that stops answering in the middle of a step (a dropped
  // stream, a timeout, a 5xx) does not end the turn: it is handed off, the
  // way a draining process hands a turn off, and the resume runs it again
  // from its last complete step (turn-resume.ts) after a short wait. The cut
  // step is not journaled (onStepFinish), its frames are rewound by the
  // resume's takeover, and a write it already ran answers from the effect
  // ledger instead of running twice (tool-effect-key.ts). Bounded by the
  // turn's attempts; past them, the turn fails with the provider_unavailable
  // line, which says to continue.
  let streamRetryDelayMs: number | null = null
  const onProviderFailure = (error: unknown): "retry" | "unavailable" | null => {
    if (streamRetryDelayMs !== null) return "retry"
    if (!isTransientProviderFailure(error, abortController.signal)) return null
    if (
      !turnResumable ||
      turnRecord.fenced ||
      handoffRequested ||
      turnAttempt >= STREAM_FAILURE_RETRIES
    ) {
      return "unavailable"
    }
    streamRetryDelayMs = streamFailureRetryDelayMs(turnAttempt)
    log.warn(
      {
        ...providerStreamErrorFields(error, model),
        threadId,
        orgId,
        turnId: turnRecord.turnId,
        attempt: turnAttempt,
        stepsComplete: stepsJournaled,
        retryInMs: streamRetryDelayMs,
        reason: "upstream_unavailable",
      },
      "Provider stopped answering mid-step: the turn runs again from its last complete step",
    )
    handoffRequested = true
    // What a drain does: tools already running finish (their ledger rows
    // reach done), the model call stops now.
    abortController.abort(DRAIN_HANDOFF_REASON)
    return "retry"
  }
  const result = runAgentStream(streamParams)

  // A false approval claim (false-approval-guard.ts): an answer saying
  // something awaits the person's approval when the turn parked none gets one
  // corrective continuation of the same turn, and the correction replaces the
  // false text in the stored reply. A read-only rerun cannot act on it, and a
  // turn the hard token limit stopped before its first step said nothing.
  // The same single continuation covers an announced action
  // (announced-action-claim.ts): a final answer saying "I'll book it now"
  // with no tool call in its step and no approval parked did nothing, so the
  // model is told to call the tool or say plainly what it cannot do.
  let falseApprovalRetraction: Retraction | null = null
  // The announced-action correction's own plan text, cut too when it ended
  // there again and one more continuation ran (correctAgain below).
  let secondRetraction: Retraction | null = null
  // Every correction continuation of this turn is one model call made through
  // here: its stream is read by the same guard as the turn's own, so each of
  // its steps reaches the turn's usage, which finalizeReply meters
  // (`finalizeUsage`) with the rest of the turn. A correction stream built
  // anywhere else would be a model call outside the turn's meter.
  const correctionStream = (
    turnMessages: unknown[],
    overrides: Pick<RunAgentStreamParams, "prepareStep"> = {},
  ) =>
    runAgentStream({
      ...streamParams,
      ...overrides,
      messages: [
        ...(contextMessages as Array<{ role: string; content: unknown }>),
        ...(turnMessages as Array<{ role: string; content: unknown }>),
      ],
      stopWhen: stopConditions(FALSE_APPROVAL_CORRECTION_MAX_STEPS),
    })
  let correction:
    | "false_approval"
    | "announced_action"
    | "false_card"
    | "false_connected"
    | "contradicted" = "false_approval"
  // The announced-action correction claimed an action it never took: the
  // stored reply is the first answer (keepContinuation below).
  let announcedActionClaimDropped = false
  // The guards on a finished answer (below): which correction it needs, if any.
  const judgeAnswer = async (
    run: { finalText: string; allText: string; toolOutputs: unknown[] },
    lookups: ReturnType<typeof falseApprovalLookups>,
  ): Promise<boolean | "all"> => {
    const reason = await assessFalseApprovalClaim(run.finalText, run.toolOutputs, lookups)
    // A card the answer points the person at, anywhere in the turn's
    // text (card-claim.ts): one of that kind must exist in this conversation. A
    // claim written before a tool call is replaced with the rest.
    const cards = reason ? null : claimedCards(run.allText)
    if (cards && cards.size > 0) {
      // A secure card in any status, or an approval still waiting, backs
      // the claim (card-claim.ts): a decided approval is no card to act on.
      const inThread = await lookups.threadCards()
      const backed = cardClaimsBacked(cards, {
        secret:
          inThread.secret ||
          run.toolOutputs.some((o) => containsSecretRequest(o) || containsShownCard(o)),
        approval:
          inThread.approval ||
          run.toolOutputs.some((o) => containsParkedApproval(o)) ||
          (await lookups.approvalsCreatedSince()).length > 0,
      })
      if (!backed) {
        correction = "false_card"
        log.info(
          {
            threadId,
            orgId,
            claims: [...cards],
            agentId: actingAgent?.agentId ?? null,
            modelId: creditCheck.model.modelId,
            falseText: run.allText.slice(0, 300),
          },
          "Card claim with no open card: running one corrective continuation of the turn",
        )
        return "all"
      }
    }
    // "Fully configured and connected" with nothing connected
    // (card-claim.ts, claimsConnectedNow): only a completed card or a
    // connected account backs it.
    if (
      !reason &&
      claimsConnectedNow(run.finalText) &&
      (await connectionClaimVerdict({
        orgId,
        threadId,
        userId: actor.userId,
        namedApps: appsNamedInClaim(run.finalText),
        turnFiledCard: run.toolOutputs.some((o) => containsSecretRequest(o)),
      })) === "false"
    ) {
      correction = "false_connected"
      log.info(
        {
          threadId,
          orgId,
          agentId: actingAgent?.agentId ?? null,
          modelId: creditCheck.model.modelId,
          falseText: run.finalText.slice(0, 300),
        },
        "Connected claim with nothing connected: running one corrective continuation of the turn",
      )
      return true
    }
    if (!reason) {
      if (
        !announcesImminentAction(run.finalText) ||
        run.toolOutputs.some((o) => containsParkedApproval(o)) ||
        (await lookups.approvalsCreatedSince()).length > 0
      ) {
        return false
      }
      correction = "announced_action"
      log.info(
        {
          threadId,
          orgId,
          agentId: actingAgent?.agentId ?? null,
          modelId: creditCheck.model.modelId,
          announcedText: run.finalText.slice(-300),
        },
        "Announced action with no tool call: running one corrective continuation of the turn",
      )
      return true
    }
    log.info(
      {
        threadId,
        orgId,
        reason,
        agentId: actingAgent?.agentId ?? null,
        modelId: creditCheck.model.modelId,
        falseText: run.finalText.slice(0, 300),
      },
      "False approval claim: running one corrective continuation of the turn",
    )
    return true
  }
  const fullStream =
    params.readOnlyTools || spentBeforeFirstStep
      ? result.fullStream
      : withFalseApprovalGuard({
          first: result,
          shouldCorrect: async (run) => {
            // A continuation is more steps: none once the turn's step budget is spent.
            if (
              abortController.signal.aborted ||
              stoppedAtHardTokenLimit ||
              turnBudget?.checkInSent === true ||
              turnBudget?.stepsLeft() === 0
            ) {
              return false
            }
            const lookups = falseApprovalLookups({
              orgId,
              threadId,
              userId: actor.userId,
              turnStartedAt,
            })
            // Text written before the last tool call that the call's result
            // contradicts (a no-op, a dedupe, a refusal: false-approval-guard.ts,
            // preCallTextContradicted). The answer after the result is judged
            // alone: clean, it is the stored reply and the text before is
            // withheld; itself false, the correction replaces everything.
            const preCallText = run.allText.slice(0, run.allText.length - run.finalText.length)
            const contradicted = preCallTextContradicted(preCallText, run.toolOutputs)
            if (contradicted) {
              const rest = await judgeAnswer({ ...run, allText: run.finalText }, lookups)
              if (rest) return "all"
              correction = "contradicted"
              log.info(
                {
                  threadId,
                  orgId,
                  outcome: contradicted,
                  agentId: actingAgent?.agentId ?? null,
                  modelId: creditCheck.model.modelId,
                  withheldText: preCallText.slice(0, 300),
                },
                "Text before a tool call contradicted by its result: withholding it from the stored reply",
              )
              return "precall"
            }
            return judgeAnswer(run, lookups)
          },
          continueWith: (responseMessages) =>
            correctionStream([
              ...responseMessages,
              {
                role: "user",
                content:
                  correction === "announced_action"
                    ? ANNOUNCED_ACTION_NOTE
                    : correction === "false_card"
                      ? FALSE_CARD_NOTE
                      : correction === "false_connected"
                        ? FALSE_CONNECTED_NOTE
                        : FALSE_APPROVAL_NOTE,
              },
            ]),
          onRetract: (retraction) => {
            falseApprovalRetraction = retraction
          },
          // A correction that again ends on its own plan ("Let me call
          // routine_tool_scopes. Let me do that.") with no tool call in its last
          // step stopped short a second time: the note is repeated once, and that
          // continuation's first step must call a tool, so the turn acts instead
          // of announcing. Its plan text is cut from the stored reply.
          correctAgain: {
            shouldCorrect: async (cont) => {
              if (correction !== "announced_action" || abortController.signal.aborted) return false
              // The correction already answered at the step budget's check-in, or spent
              // the last step: a further continuation would run past the cap.
              if (turnBudget?.checkInSent === true || turnBudget?.stepsLeft() === 0) return false
              if (!announcesImminentAction(cont.finalText)) return false
              const lookups = falseApprovalLookups({
                orgId,
                threadId,
                userId: actor.userId,
                turnStartedAt,
              })
              if ((await lookups.approvalsCreatedSince()).length > 0) return false
              log.info(
                {
                  threadId,
                  orgId,
                  agentId: actingAgent?.agentId ?? null,
                  modelId: creditCheck.model.modelId,
                  announcedText: cont.finalText.slice(-300),
                },
                "Correction ended on an announced action again: one continuation whose first step calls a tool",
              )
              return true
            },
            continueWith: (firstMessages, correctionMessages) =>
              correctionStream(
                [
                  ...firstMessages,
                  { role: "user", content: ANNOUNCED_ACTION_NOTE },
                  ...correctionMessages,
                  { role: "user", content: ANNOUNCED_ACTION_NOTE },
                ],
                { prepareStep: firstStepCallsATool(streamParams.prepareStep) },
              ),
          },
          onRetractAgain: (retraction) => {
            secondRetraction = retraction
          },
          // An announced-action correction that called no tool did nothing
          // either: one that reports an action as done ("I just re-checked")
          // is a claim of an action that did not happen. Its text is held
          // until this verdict and never shown; the first answer stays, with
          // the platform's fixed line saying nothing was run.
          holdContinuation: () => correction === "announced_action",
          droppedNotice: (first) =>
            serverT(
              replyLanguage(first.finalText) === "French" ? "fr" : "en",
              "kernel.agentNotice.actionNotRun",
            ),
          keepContinuation: (run) => {
            if (correction !== "announced_action" || run.calledTool) return true
            if (!claimsFreshAction(run.text)) return true
            log.info(
              {
                threadId,
                orgId,
                modelId: creditCheck.model.modelId,
                claim: run.text.slice(0, 300),
              },
              "Announced-action correction claimed an action with no tool call: keeping the first answer",
            )
            announcedActionClaimDropped = true
            return false
          },
        })

  // 9. Return stream + finalize callback
  const finalizeReply = async (finalParams: {
    usage: {
      promptTokens: number
      completionTokens: number
      reasoningTokens?: number
      /** Provider-reported cache-hit input tokens, summed across steps. */
      cachedInputTokens?: number
      /**
       * Provider-reported cache WRITE tokens (Anthropic's cache creation),
       * summed across steps from usage.inputTokenDetails.cacheWriteTokens
       * (G1). Absent for a provider that does not report it — not the same as
       * zero — so it can be logged as absent rather than a measured 0.
       */
      cacheWriteTokens?: number | null
      /** The 5-minute-TTL part of cacheWriteTokens (step-usage.ts). */
      cacheWrite5mTokens?: number | null
      /** The USD cost the provider reported over every step (OpenRouter); null when one step reported none. */
      providerCostUsd?: number | null
      /** Input tokens of the run's FINAL step -- the real context size (compaction metric). */
      lastStepInputTokens?: number
    }
    finishReason: string
    text: string
    /** Each step's text exactly as streamed, in order, when `text` joins the steps as
     *  paragraphs (reply-flatten.ts): a retraction, counted on the streamed text, is
     *  cut from these and the steps joined again. */
    stepTexts?: readonly string[]
    /** Accumulated reasoning/thinking text (full or summary, per the provider). */
    reasoning?: string
    /** Ordered interleave of reasoning segments and tool calls in the exact order
     *  the model emitted them, so the UI can render each tool call at the point in
     *  the thinking where it was invoked instead of dumping every call after the
     *  whole thinking block. Tool entries reference `metadata.toolCalls` by id. */
    timeline?: TurnTimelineEntry[]
    /** Raw provider/tool error detail when finishReason==="error" — persisted in
     *  metadata.error so the client can render the failure distinctly (the message
     *  `content` already carries a user-facing version). */
    errorDetail?: string
    /** The failing error's own `code` (a string one, e.g. a refusal's), persisted in
     *  metadata.errorCode so a reader of the row (the routine outcome judge) can name it. */
    errorCode?: string
    /** The failure's class when the error itself says it: the provider stopped
     *  responding, after the turn's own re-runs (`onProviderFailure`). */
    errorNotice?: ProviderNoticeCode
    /** The text written after the turn's last tool call, when the caller kept no
     *  timeline. In a shared thread it is what the turn persists (shared-thread-reply.ts). */
    finalStepText?: string
    steps: Array<{
      toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }>
      toolResults?: Array<{ toolCallId: string; result: unknown }>
      /** One per `tool-error` chunk: a call that produced no result. Its detail is
       *  what keeps the persisted row from being a bare `status: "error"`. */
      toolErrors?: Array<{ toolCallId: string; error: unknown }>
    }>
  }) => {
    turnDeadline.clear()
    // The turn is over: drop any mail this turn's browser decrypted for it. The
    // block lived in memory for the length of the turn and nowhere else.
    clearEphemeralMailboxContext(rootRunId)
    // A conversation other people read receives the turn's answer, never the
    // narration written between its tools (shared-thread-reply.ts). A private
    // chat keeps every line, drawn where it was written.
    // A corrected false approval claim was cut already: the correction is the
    // answer, so the stored reply drops the false text (`retractedAttempt`, in
    // `finalize`, before a resumed turn's earlier steps are joined in front).
    const turnOutput = finalParams
    const answer = replyForAudience({
      shared: context.sharedAudience !== null,
      text: turnOutput.text,
      finalStepText: turnOutput.finalStepText,
      timeline: turnOutput.timeline,
    })
    // A step the turn stopped mid-stream is still billed: its usage row comes from
    // OpenRouter's record, read in the background (it appears seconds after the stop).
    if (unreportedGenerations.length > 0) {
      void recordUnreportedGenerations(orgId, {
        // Taken, not copied: a second finalize records nothing twice.
        generationIds: unreportedGenerations.splice(0),
        apiKey: creditCheck.providerKey,
        modelId: creditCheck.model.modelId,
        keySource: creditCheck.keySource,
        userId: actor.userId,
      })
    }

    // A turn that ERRORED with no text must not persist as a blank agent bubble —
    // surface the failure IN THE CHAT (production + chaos): use a user-facing error
    // line as the message content so the thread shows "this response failed: <cause>"
    // instead of nothing (the BL-177 spend-cap blank-turn class). The raw detail also
    // rides in metadata.error below. Any caller that reports finishReason==="error"
    // with empty text gets this automatically (chat re-invoke, chaos agent_run, …).
    // A cut-off run tells the same lie a spend-cap blank turn does: the internal
    // timeout / credit abort ends the stream WITHOUT a finish part, so the
    // caller's accumulated finishReason still reads as the LAST step's reason
    // (typically "tool-calls") and the text is empty. Resolve the abort reason
    // here (the controller is in scope) so the persisted message and its
    // metadata carry the truthful stop cause.
    let effectiveFinishReason = finalParams.finishReason
    let content: string
    // The failure's class when the runtime wrote this message itself: persisted
    // on the row (metadata.agentNotice) so every surface renders it in its
    // reader's language instead of parsing the English line back.
    let agentNotice: ReturnType<typeof agentNoticeCode> = null
    // The routine's hard token limit ended the loop (S17): the output says so,
    // after whatever the agent had written, and the finish reason names it so
    // the routine supervisor does not re-loop the tick.
    const hardLimitStop =
      stoppedAtHardTokenLimit &&
      tokenAccount?.hardTokenLimit != null &&
      finalParams.finishReason !== "error" &&
      !abortController.signal.aborted
        ? hardTokenLimitStopText(tokenAccount.hardTokenLimit)
        : null
    // A visitor turn a newer request of theirs replaced is closed, whatever it
    // wrote (superseded-turn.ts). It is replaced only between steps: one still
    // inside a long step when the newer request arrived runs on until its clock
    // stops it, and it too was replaced, not slow ("I ran out of time" sent the
    // visitor looking for a slow turn).
    const stopReason = abortController.signal.aborted
      ? String(abortController.signal.reason ?? "aborted")
      : null
    const superseded =
      stopReason === SUPERSEDED_FINISH_REASON ||
      (stopReason === "timeout" &&
        supersedable &&
        (await turnSupersededByNewerMessage({
          orgId,
          threadId,
          messageId: userMsgId,
          senderId: actor.userId,
          agentId: actingAgent?.agentId ?? null,
        })))
    if (hardLimitStop) {
      effectiveFinishReason = "hard_token_limit"
      content = answer.text?.trim() ? `${answer.text.trimEnd()}\n\n${hardLimitStop}` : hardLimitStop
      log.info(
        {
          threadId,
          routineId: params.routineId,
          used: tokenAccount?.used,
          hardTokenLimit: tokenAccount?.hardTokenLimit,
        },
        "Run stopped at the routine's hard token limit",
      )
    } else if (superseded) {
      effectiveFinishReason = SUPERSEDED_FINISH_REASON
      content = supersededTurnContent(answer.text)
      log.info(
        { threadId, stopReason, stepCount: finalParams.steps.length },
        "Visitor turn superseded: closing it after what it wrote",
      )
    } else if (answer.text?.trim() && finalParams.finishReason === "error") {
      // A turn that wrote some text and then failed: the text stays, and the
      // failure is said under it with its detail rather than dropped.
      content = `${answer.text.trimEnd()}\n\n${userFacingAgentError(finalParams.errorDetail ?? null, finalParams.errorNotice)}`
      log.warn(
        {
          threadId,
          providerDetail: finalParams.errorDetail?.slice(0, 2000),
          textLen: answer.text.length,
        },
        "Agent turn failed after writing part of its answer",
      )
    } else if (
      answer.text?.trim() &&
      (stopReason === "timeout" ||
        stopReason === "credits_exhausted" ||
        stopReason === "token_budget_exceeded")
    ) {
      // A turn its own limit stopped in the middle of a step, after it wrote
      // something: what it wrote stays, and the stop is said under it. Kept
      // alone, the reply read as an answer that broke off mid-sentence.
      effectiveFinishReason = stopReason
      const demoStop = stopReason === "credits_exhausted" ? await turnDemoRefusal() : null
      content = `${answer.text.trimEnd()}\n\n${
        demoStop?.text ??
        userFacingIncompleteTurn(stopReason, finalParams.steps.length, turnDeadline.describe())
      }`
      log.warn(
        {
          threadId,
          finishReason: finalParams.finishReason,
          abortReason: stopReason,
          stepCount: finalParams.steps.length,
          textLen: answer.text.length,
        },
        "Agent turn stopped by its own limit after writing part of its answer",
      )
    } else if (answer.text?.trim()) {
      content = answer.text
    } else if (finalParams.finishReason === "error") {
      agentNotice =
        finalParams.errorNotice ?? classifyProviderError(finalParams.errorDetail ?? null)
      content = userFacingAgentError(finalParams.errorDetail ?? null, finalParams.errorNotice)
      if (finalParams.errorDetail) {
        log.warn(
          { threadId, agentNotice, providerDetail: finalParams.errorDetail.slice(0, 2000) },
          "Agent turn failed at the provider",
        )
      }
    } else {
      if (
        stopReason === "timeout" ||
        stopReason === "credits_exhausted" ||
        stopReason === "token_budget_exceeded"
      ) {
        effectiveFinishReason = stopReason
      }
      const demoStop =
        effectiveFinishReason === "credits_exhausted" ? await turnDemoRefusal() : null
      content =
        demoStop?.text ??
        userFacingIncompleteTurn(
          effectiveFinishReason,
          finalParams.steps.length,
          turnDeadline.describe(),
        )
      agentNotice = agentNoticeCode(content)
      log.warn(
        {
          threadId,
          finishReason: finalParams.finishReason,
          effectiveFinishReason,
          abortReason: stopReason,
          stepCount: finalParams.steps.length,
        },
        "Agent turn ended with no text — persisting an explicit stop message instead of a blank reply",
      )
    }

    // The turn's final scope set: every tool call has run by finalize, and the
    // accumulator recorded each one before it ran, so an abnormal end is tagged
    // with what the turn actually read, never widened to the ceiling (A2).
    const requiredScopes = turnEndRequiredScopes({
      accumulator: runFrame.turnScopeAccumulator,
      fullEffectiveScope: runFrame.effectiveScope,
      requesterScopes: actor.scopes,
      orgId,
    })
    // The requester's private card sees categories only, never the raw names.
    const withheldRaw = runFrame.withheld ?? []
    const withheldCards = describeWithheldCapabilities(withheldRaw)
    // The same set, stored on the reply so the card survives a refetch (D1).
    // The block names the REQUESTER: the row is shared into the room, and the
    // read path (`projectMessageMetadataForViewer`) strips it for everyone
    // else, which is what makes the card per user. `nonDisclosable` is read
    // here rather than at the click, so the card can hide "Share anyway" for
    // an offer that would be refused.
    const withheldBlock =
      withheldRaw.length === 0
        ? undefined
        : buildWithheldMessageMetadata({
            requesterId: actor.userId,
            turnId: userMsgId,
            withheldScopes: withheldRaw,
            nonDisclosableScopes: await withPrivilegedDb(
              orgId,
              "withheld-disclosure-policy",
              async (tx) => {
                const db = tx as unknown as RlsClient
                // The server's Share anyway gate reads its own set (the ceiling
                // entries the requester's DM scope leaves out). When that gate
                // would refuse, the whole card is closed: offering a click the
                // server then refuses is the one outcome the card must avoid.
                // The requester's grants as the gate reads them: live rows
                // narrowed by the session's own scopes.
                const live = (await loadEffectivePermissions(tx, actor.userId, orgId)).scopes
                const grants = intersectScopes(live, actor.scopes)
                const ceiling = runFrame.agentCeiling ?? []
                const gate = withheldCapabilities(ceiling, effectiveScopeDm(ceiling, grants))
                if ((await listBlockingNonDisclosableScopes(db, orgId, gate)).length > 0) {
                  return withheldRaw
                }
                return listBlockingNonDisclosableScopes(db, orgId, withheldRaw)
              },
            ),
            // A tool call this turn was refused by scope taint, so a rerun of
            // it is refused the same way: the card offers "Continue in a DM"
            // instead of a "Share anyway" that could only fail.
            scopeTainted: runFrame.scopeTaintRefused === true,
          })

    // P3b-FX3: in a coordination exchange the callee's ANSWER row is read by a
    // person the moment the nested exchange is expanded, so a machine name the
    // callee repeated out of its own prompt reaches them there just as it did
    // through the relay. The row is written scrubbed and the unscrubbed text is
    // kept on the metadata, under a key no surface renders, so the audit keeps
    // exactly what the agent said. A human facing turn is the agent's own
    // speech to the room and is left alone: prompt discipline governs it.
    const coordinationContent = params.coordination
      ? (() => {
          const scrubbed = redactToolIdentifiers(content, orgId)
          return scrubbed === content
            ? { content, raw: undefined as string | undefined }
            : { content: scrubbed, raw: content }
        })()
      : { content, raw: undefined as string | undefined }

    // Tool calls and usage, stored on the reply's metadata
    const toolCalls = extractToolCalls(finalParams.steps, runFrame.taintedToolCallIds)
    // The tools THIS turn unlocked, on the row: the discovery window reads
    // them back from the rows after the checkpoint boundary.
    const discoveredThisTurn = [...discoveredTools].filter((n) => !discoveredAtStart.has(n)).sort()
    // The tools this turn sent, in the order sent: the next turn keeps it.
    const toolOrder = Object.keys(tools).filter((name) =>
      fixedToolList ? fixedToolList.has(name) : sentTools.has(name),
    )
    // A visitor turn the spend gate stopped mid-way names why, so the client
    // can act on it (the email-code prompt, the next-steps dialog).
    const demoRefusalCode = creditCheck.demo?.refusal ?? null
    const metadata = {
      ...(demoRefusalCode ? { demoRefusal: demoRefusalCode } : {}),
      // The turn this reply ends, stored as the live copy carries it: a view
      // that reads the reply from a page (a reload, a reconnect's resync after
      // the socket dropped the turn's last frames) ends that turn's live block
      // with it. Stored only on the live copy, the page's reply named no turn
      // and the block kept "working" under the finished answer.
      turnId: userMsgId,
      // The person's message this reply answers: `turnId` itself, except on
      // the turn an approved call handed back, whose trigger is the result row.
      askId,
      modelId: creditCheck.model.modelId,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      // A routine run's turn: its reply names the run, so a flow's `tool_called` outcome counts
      // this run's calls only (flow-runner.ts).
      ...(runFrame.routineRunId ? { routineRunId: runFrame.routineRunId } : {}),
      ...(discoveredThisTurn.length > 0 ? { [DISCOVERED_TOOLS_META_KEY]: discoveredThisTurn } : {}),
      ...(toolOrder.length > 0 ? { [TOOL_ORDER_META_KEY]: toolOrder } : {}),
      ...(guideNotes.length > 0 ? { [GUIDE_NOTES_META_KEY]: guideNotes } : {}),
      stepCount: finalParams.steps.length,
      usage: {
        inputTokens: finalParams.usage.promptTokens,
        outputTokens: finalParams.usage.completionTokens,
        // outputTokens already includes reasoning tokens; we surface the breakdown
        // for transparency, not as additional billed output.
        reasoningTokens: finalParams.usage.reasoningTokens || undefined,
        // Cache-hit input tokens (subset of inputTokens) — prompt-cache
        // effectiveness observability. Zero/absent means no hits reported.
        cachedInputTokens: finalParams.usage.cachedInputTokens || undefined,
        // The FINAL step's input tokens — the real context size. `inputTokens`
        // above is the sum across steps (billing); compaction reads this one.
        lastStepInputTokens: finalParams.usage.lastStepInputTokens || undefined,
      },
      reasoningLevel: effectiveReasoningLevel === "off" ? undefined : effectiveReasoningLevel,
      reasoning: finalParams.reasoning || undefined,
      // A closed superseded turn draws its closing line after its tools.
      timeline: answer.timeline?.length
        ? superseded
          ? [...answer.timeline, { kind: "text" as const, text: SUPERSEDED_TURN_TEXT }]
          : answer.timeline
        : undefined,
      finishReason: effectiveFinishReason,
      error: finalParams.errorDetail || undefined,
      errorCode: finalParams.errorCode || undefined,
      ...(agentNotice ? { agentNotice } : {}),
      ...(announcedActionClaimDropped
        ? { announcedActionCorrectionDropped: true }
        : falseApprovalRetraction
          ? correction === "announced_action"
            ? { announcedActionCorrected: true }
            : correction === "false_card"
              ? { falseCardCorrected: true }
              : correction === "false_connected"
                ? { falseConnectedCorrected: true }
                : correction === "contradicted"
                  ? { contradictedTextWithheld: true }
                  : { falseApprovalCorrected: true }
          : {}),
      ...(withheldBlock ? { withheld: withheldBlock } : {}),
      ...(coordinationContent.raw
        ? { [COORDINATION_RAW_CONTENT_KEY]: coordinationContent.raw }
        : {}),
    }

    // A turn its own deadline stopped did not finish: it is recorded failed,
    // as an errored one is, never a silent `done`.
    const turnFailed = finalParams.finishReason === "error" || effectiveFinishReason === "timeout"
    const turnErrorCode =
      finalParams.errorCode ?? (effectiveFinishReason === "timeout" ? "timeout" : null)
    if (!persistReply) {
      await finishTurn({
        orgId,
        turnId: turnRecord.turnId,
        runner: turnRecord.runner,
        state: turnFailed ? "failed" : "done",
        // A turn that ran to its end failed on its own (a model or tool error, its deadline).
        failureReason: turnFailed ? "turn" : null,
        errorCode: turnErrorCode,
      })
      // The caller persists the reply through its own path; the model was
      // still used, so credits are still deducted.
      const { creditCost } = await finalizeUsage(orgId, {
        model: creditCheck.model,
        inputTokens: finalParams.usage.promptTokens,
        outputTokens: finalParams.usage.completionTokens,
        cachedInputTokens: finalParams.usage.cachedInputTokens,
        cacheWriteTokens: finalParams.usage.cacheWriteTokens ?? undefined,
        cacheWrite5mTokens: finalParams.usage.cacheWrite5mTokens ?? undefined,
        providerCostUsd: finalParams.usage.providerCostUsd ?? undefined,
        keySource: creditCheck.keySource,
        userId: actor.userId,
        ...(creditCheck.demo ? { demo: creditCheck.demo } : {}),
      })
      return {
        messageId: null,
        creditCost,
        finishReason: effectiveFinishReason,
        reply: { content, requiredScopes, metadata },
        withheldCapabilities: withheldCards,
      }
    }

    // Persist agent message: the row, its metadata and the live copy, through
    // the one path every agent turn takes, local ones included
    // (`persist-agent-turn.ts`). The live copy carries a SUBSET of the stored
    // metadata (no usage, no coordination raw text) plus the withheld block,
    // which the socket projects per connection (`projectWithheldMetadata`).
    let fencedAtPersist = false
    const agentMsg = await persistAgentTurn({
      // The record's end and the reply commit together, the record FIRST: a
      // runner fenced at this point inserts no message (S10).
      write: (fn) =>
        withPrivilegedDb(orgId, "agent-agent-msg", async (tx) => {
          const ended = await finishTurn(
            {
              orgId,
              turnId: turnRecord.turnId,
              runner: turnRecord.runner,
              state: turnFailed ? "failed" : "done",
              failureReason: turnFailed ? "turn" : null,
              errorCode: turnErrorCode,
            },
            tx,
          )
          if (ended === "fenced") throw new TurnFencedAtPersist()
          const row = await fn(tx as unknown as RlsClient)
          const id = (row as { id?: unknown } | null)?.id
          if (typeof id === "string") await setTurnReply(tx, orgId, turnRecord.turnId, id)
          return row
        }),
      orgId,
      userId: actor.userId,
      threadId,
      content: coordinationContent.content,
      broadcastContent: content,
      // The turn's frame is plumbed into `buildToolSet`, never opened around
      // this call, so `currentRunContext()` is undefined here and the acting
      // agent is handed over explicitly. When the thread resolved no agent
      // this is undefined, NOT an explicit null: null is the emitter saying
      // "there was no agent", which would stop the write path resolving one,
      // and an agent-authored row must name a speaker (0080).
      agentId: runFrame.agentId,
      requiredScopes,
      // P3b: null on a human facing turn; the triggering message on a turn
      // an agent started, for every message the turn writes.
      parentMessageId: params.coordination?.parentMessageId ?? null,
      // A7: the answer lands in the reply thread the turn was asked in.
      replyRootId,
      ...(params.unprompted ? { unprompted: true } : {}),
      // The end of a turn a PERSON started (in the app, over MCP, from any
      // client), failed, cut or timed out included: they are told once. A turn
      // answering another AGENT is chatter between agents; the asking agent's
      // own summary is what tells the person (etiquette rule 1).
      endsTurn: !params.coordination?.callerAgentId,
      metadata,
      broadcastMetadata: {
        modelId: creditCheck.model.modelId,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: effectiveFinishReason,
        stepCount: finalParams.steps.length,
        reasoningLevel: effectiveReasoningLevel === "off" ? undefined : effectiveReasoningLevel,
        reasoning: finalParams.reasoning || undefined,
        timeline: answer.timeline?.length ? answer.timeline : undefined,
        error: finalParams.errorDetail || undefined,
        ...(agentNotice ? { agentNotice } : {}),
        ...(demoRefusalCode ? { demoRefusal: demoRefusalCode } : {}),
        // The turn this reply ends: a live view ends that turn's block, never
        // the block of a newer turn of the same agent still running.
        turnId: userMsgId,
        askId,
        // THE CARD DRAWS AT THE END OF THE TURN, not on the next open. The
        // live copy rebuilt a SUBSET of the stored metadata and left the
        // withheld block out, so a turn that withheld something streamed,
        // landed and showed nothing: the card only appeared when the thread
        // was fetched again. The block is private to the requester and the
        // socket projects it per connection (`projectWithheldMetadata`),
        // exactly as the read path does.
        ...(withheldBlock ? { withheld: withheldBlock } : {}),
      },
    }).catch((err: unknown) => {
      if (!(err instanceof TurnFencedAtPersist)) throw err
      fencedAtPersist = true
      return null
    })

    if (!agentMsg && fencedAtPersist) {
      turnRecord.fenced = true
      log.warn({ threadId, turnId: turnRecord.turnId }, "turn_fenced_no_reply")
      return {
        messageId: null,
        creditCost: "0",
        finishReason: FENCED_REASON,
        withheldCapabilities: [],
      }
    }
    if (!agentMsg) {
      throw new HTTPException(500, { message: "Failed to persist agent message" })
    }

    // Persist tool discoveries so follow-up turns keep them loaded. The set
    // can also SHRINK here (the window expired older discoveries at load), so
    // the write is on any change, not only on growth.
    const names = [...discoveredTools].sort()
    if (names.join("\n") !== persistedDiscoveredNames.join("\n")) {
      await withPrivilegedDb(orgId, "agent-discovered-tools-persist", async (tx) => {
        await tx
          .update(threads)
          .set({ agentDiscoveredTools: names })
          .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
      })
    }

    // Deduct credits
    const { creditCost } = await finalizeUsage(orgId, {
      model: creditCheck.model,
      inputTokens: finalParams.usage.promptTokens,
      outputTokens: finalParams.usage.completionTokens,
      cachedInputTokens: finalParams.usage.cachedInputTokens,
      cacheWriteTokens: finalParams.usage.cacheWriteTokens ?? undefined,
      cacheWrite5mTokens: finalParams.usage.cacheWrite5mTokens ?? undefined,
      providerCostUsd: finalParams.usage.providerCostUsd ?? undefined,
      keySource: creditCheck.keySource,
      userId: actor.userId,
      ...(creditCheck.demo ? { demo: creditCheck.demo } : {}),
    })

    await supersedeOlderToolCards({
      orgId,
      actorId: actor.userId,
      threadId,
      messageId: agentMsg.id,
      createdAt: agentMsg.createdAt,
      toolCalls,
    })

    return {
      messageId: agentMsg.id,
      creditCost,
      finishReason: effectiveFinishReason,
      withheldCapabilities: withheldCards,
    }
  }

  // THE TURN'S END, as its record sees it (S10). A fenced runner writes
  // nothing (the process that owns the turn now writes the reply). A turn
  // handed off by a draining process is left `handoff` for a resume. Any
  // other end folds the earlier attempts' steps into this one's and finishes
  // the record in the reply's own transaction.
  let turnEnded = false
  const finalize: RunAgentChatResult["finalize"] = async (finalParams) => {
    if (turnEnded) {
      return {
        messageId: null,
        creditCost: "0",
        finishReason: FENCED_REASON,
        withheldCapabilities: [],
      }
    }
    turnEnded = true
    try {
      if (turnRecord.fenced) {
        turnDeadline.clear()
        clearEphemeralMailboxContext(rootRunId)
        await creditCheck.demo?.finish()
        log.warn({ threadId, turnId: turnRecord.turnId }, "turn_fenced_no_reply")
        return {
          messageId: null,
          creditCost: "0",
          finishReason: FENCED_REASON,
          withheldCapabilities: [],
        }
      }
      if (handoffRequested) {
        turnDeadline.clear()
        clearEphemeralMailboxContext(rootRunId)
        await creditCheck.demo?.finish()
        const { handOffTurn } = await import("~/modules/agent/runtime/turn-resume")
        await handOffTurn(
          orgId,
          turnRecord.turnId,
          streamRetryDelayMs !== null ? { delayMs: streamRetryDelayMs } : {},
        )
        return {
          messageId: null,
          creditCost: "0",
          finishReason: HANDOFF_FINISH_REASON,
          withheldCapabilities: [],
        }
      }
      const ownOutput = retractedAttempt(finalParams, {
        first: falseApprovalRetraction,
        second: secondRetraction,
      })
      return await finalizeReply(
        withPriorSteps(ownOutput, await withToolCardFieldsOnSteps(orgId, priorViews)),
      )
    } finally {
      unregisterTurn()
    }
  }

  return {
    userMessageId: userMsgId,
    askId,
    replyRootId,
    fullStream,
    finalize,
    abandon: async () => {
      turnDeadline.clear()
      await creditCheck.demo?.finish()
      if (!turnEnded) {
        turnEnded = true
        unregisterTurn()
        await finishTurn({
          orgId,
          turnId: turnRecord.turnId,
          runner: turnRecord.runner,
          state: "interrupted",
          // The caller left before any output.
          failureReason: "client",
        }).catch((err: unknown) => log.warn({ err, threadId }, "Could not close the turn record"))
      }
    },
    turnId: turnRecord.turnId,
    turnFenced: () => turnRecord.fenced,
    turnHandoff: () => handoffRequested,
    onProviderFailure,
    demoRefusal: turnDemoRefusal,
    actingAgentId: actingAgent?.agentId ?? null,
    stepCtx,
    discoveredTools,
    // Read through to the live accumulator, never a copy: the stream mirrors
    // call this per chunk and must see what the turn has touched by then.
    turnAccumulatedScopes: () => runFrame.turnScopeAccumulator.snapshot(),
    sharedThread: context.sharedAudience !== null,
  }
}

/**
 * Invoke the agent for a thread in response to an already-persisted user message.
 * Unlike runAgentChat(), this does NOT persist the user message — it expects the
 * caller (the thread route handler) to have already done so via sendMessage().
 * The agent reply is streamed, finalized internally, and broadcast via WS.
 */
const REASONING_LEVELS = ["off", "low", "medium", "high"] as const

/** A journaled reasoning level read back, or null when it is not one. */
function asReasoningLevel(value: string | null | undefined): ReasoningLevel | null {
  return REASONING_LEVELS.find((level) => level === value) ?? null
}

/**
 * Start a thread turn, tracked until it finalizes so a shutdown waits for it
 * (active-turns.ts). The turn itself is `runThreadTurn` below.
 */
export function invokeAgentForThread(
  ...args: Parameters<typeof runThreadTurn>
): ReturnType<typeof runThreadTurn> {
  return trackTurn(`thread:${args[0]}:${args[1]}`, async () => {
    // An org moving to another instance starts no turn once frozen (a
    // draining org still does: its drain waits for it, counted below).
    const orgId = args[3]
    // Counted first, then checked: a freeze landing in between is seen.
    const end = beginOrgActivity(orgId, "turns")
    try {
      await assertOrgStartsTurns(orgId)
      return await runThreadTurn(...args)
    } finally {
      end()
    }
  })
}

async function runThreadTurn(
  threadId: string,
  messageId: string,
  actor: {
    userId: string
    orgId: string
    roles?: string[]
    scopes: string[]
    dimensionGrants?: Record<string, string[]>
  },
  orgId: string,
  // The single funnel for live-user @-mentions (foreground), routine ticks, and
  // re-invocations (background). Background callers pass true so the chat's tool
  // dispatch is worker-pool-tagged "background"; a live mention leaves the default.
  background = false,
  // Per-turn budget supplied by the routine supervisor (A1). Absent for every
  // foreground caller ⇒ today's STEP_LIMIT / TIMEOUT_MS, byte-identical behaviour.
  budget?: AgentBudget,
  // The id of the routine whose tick is driving this invocation (routine ticks only). Threaded into
  // runAgentChat → the run frame so buildToolSet admits the routine-only web_watch / watch_state tools.
  // Absent for foreground mentions + non-routine re-invocations (those keep web_watch invisible).
  routineId?: string,
  // Per-tick discovery set from the routine supervisor — see RunAgentChatParams.seedDiscoveredTools.
  seedDiscoveredTools?: Set<string>,
  // Anchor the assembled history at the triggering message (same slicing routine
  // ticks get via routineId). Bundle-failure re-invocations on a routine output
  // thread pass true: the failure-context message is self-contained, and the
  // un-anchored thread history (every prior tick's replayed transcript) measured
  // OVER the model's context window — the healing turn then 400s and never runs.
  anchorHistory?: boolean,
  // The agent an `@mention` addressed (P4b-T16). A channel message names WHICH
  // agent answers; absent for a DM, a routine tick and a re-invocation, which
  // keep resolving the requester's own personal agent.
  actingAgentId?: string,
  // An AGENT started this turn (P3b): who asked, and the message the whole
  // exchange hangs under. An options object rather than two more positionals.
  // Every message this turn persists takes that same parent, so an agent only
  // exchange nests one level under the ask instead of growing a link per reply.
  // Absent for every existing caller (a human mention, a DM, a routine tick, a
  // re-invocation), which keeps writing flat at the thread root.
  coordination?: TurnCoordination,
  // What the human's live surface knows about this turn (P4c-T10): the app they
  // are looking at, and the mailbox turn nonce their browser minted. The agent
  // panel's /agent/chat route hands runAgentChat both directly; a turn started
  // from a THREAD reaches the same run frame through here, so the two surfaces
  // give the turn the same context. Absent for a routine tick and every
  // re-invocation, which have no browser behind them.
  turnContext?: {
    currentView?: { tabType: string; entityId: string }
    mailboxTurnNonce?: string
    clientSurface?: ClientSurface
    /** Another agent started this turn: see RunAgentChatParams.agentDispatched. */
    agentDispatched?: boolean
    /** See RunAgentChatParams.sessionRestricted. */
    sessionRestricted?: boolean
    /** The person's message this turn answers, when it is not `messageId`: see RunAgentChatParams.askId. */
    askId?: string
    /** A turn nobody asked for, whose reply is news to the person: see RunAgentChatParams.unprompted. */
    unprompted?: boolean
    /** Continue a claimed turn (turn-resume.ts): see RunAgentChatParams.resume. */
    resume?: { turn: AgentTurnRow; steps: JournalStep[] }
    /** The turn's durable origin; absent inside a job: the job's (job-origin.ts). */
    originRef?: string
    /** The reply thread the turn answers in: see RunAgentChatParams.replyRootId. */
    replyRootId?: string | null
  },
): Promise<{
  finishReason: string
  turnsAdded?: number
  /** Category labels for the requester's private card; see finalize. */
  withheldCapabilities?: string[]
}> {
  const { participant, roles } = await withPrivilegedDb(
    orgId,
    "agent-thread-participant",
    async (tx) => {
      const [row] = await tx
        .select({ threadId: threadParticipants.threadId })
        .from(threadParticipants)
        .where(
          and(
            eq(threadParticipants.threadId, threadId),
            eq(threadParticipants.userId, actor.userId),
            eq(threadParticipants.orgId, orgId),
          ),
        )
        .limit(1)
      // The asker's roles, when the caller did not bring them: a thread post,
      // a mention and a routine tick carry scopes and grants but no roles, and
      // a document shared with a role (Knowledge role shares) is visible only
      // to a reader whose RLS context holds that role. The chat route passes
      // the session's roles; every other entry reads them here, so the turn
      // reads with exactly the access the person has.
      const roles =
        actor.roles ?? (row ? (await loadEffectivePermissions(tx, actor.userId, orgId)).roles : [])
      return { participant: row, roles }
    },
  )

  if (!participant) {
    throw new HTTPException(403, { message: "Not a participant of this thread" })
  }

  // A JOB'S TURN IS ONE TURN (S10, M4): a re-run of the job (stalled, handed
  // back at shutdown) meets the turn its first run opened. A finished one is
  // not answered again; an unfinished one is resumed from its journal.
  const resume = turnContext?.resume
  let retryTurn: AgentTurnRow | undefined
  const originRef = resume
    ? undefined
    : (turnContext?.originRef ?? nextJobTurnOriginRef() ?? undefined)
  if (originRef) {
    const existing = await findByOriginRef(orgId, originRef)
    if (existing) {
      log.info(
        { threadId, turnId: existing.id, state: existing.state, originRef },
        "turn_origin_rerun",
      )
      if (existing.state === "running" || existing.state === "handoff") {
        const { enqueueTurnResume } = await import("~/modules/agent/runtime/turn-resume")
        await enqueueTurnResume(orgId, existing.id, existing.attempt)
        return { finishReason: HANDOFF_FINISH_REASON }
      }
      // Answered already: a re-run does not answer twice.
      if (existing.state === "done") return { finishReason: "stop" }
      // Failed or interrupted (a provider error, a stopped turn): the job's
      // retry answers again, as a new attempt of the same turn (M5).
      retryTurn = existing
    }
  }

  const userContext: UserContext = {
    actorType: "user",
    userId: actor.userId,
    orgId,
    scopes: actor.scopes,
    dimensionGrants: actor.dimensionGrants ?? {},
    roles,
  }

  // Read thread-level model + per-model reasoning overrides (set via the agent
  // message "..." menu). The reasoning map is keyed by modelId, so resolve the
  // level for the currently-selected model (Auto has no per-model entry → off).
  const threadRow = await withPrivilegedDb(orgId, "agent-thread-model", async (tx) => {
    const [row] = await tx
      .select({
        agentModelId: threads.agentModelId,
        agentReasoningLevels: threads.agentReasoningLevels,
      })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
      .limit(1)
    return row
  })

  // The agent's OWN default, under the conversation's override. Until this
  // read existed `agents.model_preference` was a column nothing consulted: an
  // unpinned chat went straight to the org's auto-select, so an agent
  // configured for opus answered on whatever auto picked.
  // A default whose provider this org has no usable key for falls back to
  // auto, which picks among the providers it can use (usableDefaultModel).
  const actingAgentModelPreference = actingAgentId
    ? await usableDefaultModel(
        orgId,
        await withPrivilegedDb(orgId, "agent-model-preference", async (tx) => {
          const [row] = await tx
            .select({ modelPreference: agents.modelPreference })
            .from(agents)
            .where(and(eq(agents.id, actingAgentId), eq(agents.orgId, orgId)))
            .limit(1)
          return row?.modelPreference ?? null
        }),
      )
    : null
  const selectedModelId = resolveEffectiveAgentModel({
    threadModelId: threadRow?.agentModelId ?? null,
    agentModelPreference: actingAgentModelPreference,
  })
  const threadReasoningLevels = (threadRow?.agentReasoningLevels ?? {}) as Record<
    string,
    ReasoningLevel
  >
  const threadReasoningLevel = selectedModelId
    ? (threadReasoningLevels[selectedModelId] ?? null)
    : null

  // Per-ROUTINE model/reasoning pin (routine.agentModelId / routine.agentReasoningLevel). Loaded only
  // for a routine tick (routineId present) — a live @-mention or non-routine re-invocation has no routine
  // row to pin from and keeps the thread-level behavior unchanged. Settable at create/update time and
  // from the routine detail UI, so a routine can be configured BEFORE its output thread even exists (the
  // thread is created lazily on first tick).
  const routineRow = routineId
    ? await withPrivilegedDb(orgId, "agent-routine-model", async (tx) => {
        const [row] = await tx
          .select({
            agentModelId: routines.agentModelId,
            agentReasoningLevel: routines.agentReasoningLevel,
          })
          .from(routines)
          .where(and(eq(routines.id, routineId), eq(routines.orgId, orgId)))
          .limit(1)
        return row
      })
    : null

  // ROUTINE-TICK MODEL/REASONING OVERRIDE (deep-week-sim runtime-execution gate ladder + per-routine
  // pin). A routine TICK (background=true) resolves its model/reasoning with precedence: the chaos
  // escalation-ladder env (top, background-only) > the routine's OWN agentModelId/agentReasoningLevel >
  // the thread's setting (null → org auto-select / off). The chaos envs
  // (`LIAISON_CHAOS_AGENT_MODEL` / `LIAISON_CHAOS_REASONING_LEVEL`) are threaded into the CONDUCTOR
  // conversation via the chaos agent-stream bridge and otherwise never reach the routine tick — kept top
  // precedence so a chaos run can still force a pinned model even over a routine's own pin. Validated
  // against the reasoning enum at each level; an unknown value falls through to the next level.
  const { modelId: tickModelId, reasoningLevel: tickReasoningLevel } =
    resolveRoutineTickModelOverride({
      background,
      threadModelId: selectedModelId ?? undefined,
      threadReasoningLevel,
      routineModelId: routineRow?.agentModelId ?? null,
      routineReasoningLevel: (routineRow?.agentReasoningLevel as ReasoningLevel | null) ?? null,
      env: process.env,
    })

  // The turn runs from here, not from its first frame: setting it up can take
  // many seconds before `start`, and a view loaded meanwhile (a reload just
  // after the ask was sent) learns what runs only from the stream registry.
  // The agent is resolved as runAgentChat resolves it, so `start` lands on the
  // same entry; one that names another agent withdraws this one.
  const acceptedAgentId =
    actingAgentId ??
    (
      await withPrivilegedDb(orgId, "agent-accepted-turn", (tx) =>
        resolveActingAgent(tx, orgId, actor.userId, routineId),
      )
    )?.id ??
    null
  // Redis failing here does not stop the turn (open): it runs, and only a view
  // loaded before its first frame misses it.
  // The live entry of a resumed turn is the first attempt's, taken over by
  // the resume (stream-registry takeOverLiveTurn): no new "accepted".
  const liveTurnId = resume ? (resume.turn.resumeInput.liveTurnKey ?? undefined) : messageId
  const notAccepted = { accepted: false, withdraw: async () => false }
  const acceptedTurn = resume
    ? notAccepted
    : await recordAgentTurnAccepted(threadId, orgId, {
        agentId: acceptedAgentId,
        turnId: messageId,
        askId: turnContext?.askId ?? messageId,
        requesterId: actor.userId,
      }).catch((err: unknown) => {
        log.warn({ err, threadId }, "Could not record the accepted turn in the live registry")
        return notAccepted
      })
  // THE VIEWS ALREADY OPEN learn of the accepted turn too, not only a view
  // loaded later: an open conversation drew a turn from its `start` alone, so
  // for the whole setup it showed nothing, and a newer turn of the same agent
  // asked while an older one still answered appeared only after that one's
  // reply had landed (two turns on screen, never at once). The frame carries no
  // content and no scopes, so the fan-out sends it to the requester's own
  // connections, as the replay route serves the accepted entry. Its `start`
  // (same agent, same turn) takes the block over; `withdrawn` removes it when
  // the turn ends before `start` or `start` names another agent.
  const acceptedFrame = (action: "accepted" | "withdrawn", replyRootId: string | null) =>
    broadcastEphemeral({
      app: "kernel",
      entity: "agent_stream",
      action,
      entityId: threadId,
      orgId,
      actorId: actor.userId,
      actorType: "agent",
      data: {
        threadId,
        agentId: acceptedAgentId,
        turnId: messageId,
        askId: turnContext?.askId ?? messageId,
        replyRootId,
      },
    }).catch((err: unknown) =>
      log.warn({ err, threadId, action }, "Could not tell the open views of the accepted turn"),
    )
  // The reply thread it answers in, so a view draws it where `start` will.
  const acceptedReplyRootId = acceptedTurn.accepted
    ? turnContext?.replyRootId !== undefined
      ? turnContext.replyRootId
      : await triggerReplyRootId(orgId, messageId)
    : null
  if (acceptedTurn.accepted) await acceptedFrame("accepted", acceptedReplyRootId)
  const withdrawAccepted = () =>
    acceptedTurn
      .withdraw()
      .then((removed) => (removed ? acceptedFrame("withdrawn", acceptedReplyRootId) : undefined))
      .catch((err: unknown) =>
        log.warn({ err, threadId }, "Could not withdraw the accepted turn from the live registry"),
      )

  // A resumed turn continues on the model and reasoning level it started with
  // (its journal holds that provider's messages); a pin changed in between
  // applies from the next turn.
  const resumedModelId = resume?.turn.resumeInput.modelId ?? undefined
  const result = await getRunAgentChat()({
    threadId,
    content: "",
    modelId: resumedModelId ?? tickModelId,
    reasoningLevel: resume
      ? (asReasoningLevel(resume.turn.resumeInput.reasoningLevel) ?? tickReasoningLevel)
      : tickReasoningLevel,
    actor: userContext,
    orgId,
    skipUserPersist: true,
    userMessageId: messageId,
    background,
    budget,
    // Routine tick → stamp the run frame's routineId so the routine-only tools (web_watch / watch_state)
    // are admitted to this tick's tool set. Undefined for foreground / non-routine callers.
    routineId,
    seedDiscoveredTools,
    anchorHistory,
    actingAgentId,
    coordination,
    // Absent stays ABSENT: a `mailboxTurnNonce` key with no value is not the
    // same claim as no nonce at all, and the decrypt path reads its presence.
    ...(turnContext?.currentView ? { currentView: turnContext.currentView } : {}),
    ...(turnContext?.mailboxTurnNonce ? { mailboxTurnNonce: turnContext.mailboxTurnNonce } : {}),
    ...(turnContext?.clientSurface ? { clientSurface: turnContext.clientSurface } : {}),
    ...(turnContext?.agentDispatched ? { agentDispatched: true } : {}),
    ...(turnContext?.sessionRestricted ? { sessionRestricted: true } : {}),
    ...(turnContext?.askId ? { askId: turnContext.askId } : {}),
    ...(turnContext?.unprompted ? { unprompted: true } : {}),
    ...(turnContext?.replyRootId !== undefined ? { replyRootId: turnContext.replyRootId } : {}),
    ...(resume ? { resume } : {}),
    ...(retryTurn ? { retryTurn } : {}),
    ...(originRef ? { originRef } : {}),
    ...(liveTurnId ? { liveTurnId } : {}),
    origin: resume ? resume.turn.origin : routineId ? "routine" : background ? "job" : "thread",
  }).catch(async (err: unknown) => {
    await withdrawAccepted()
    throw err
  })

  // The last frame's broadcast: the turn returns once it has gone out.
  let streamSent: Promise<void> = Promise.resolve()
  const broadcastStreamFrame = (
    action: string,
    data: Record<string, unknown>,
    frame: RecordedFrame | null,
    streamAgentId: string | null,
    accumulatedScopes: string[] | undefined,
  ): Promise<void> =>
    broadcastEphemeral({
      app: "kernel",
      entity: "agent_stream",
      action,
      entityId: threadId,
      orgId,
      actorId: actor.userId,
      actorType: "agent",
      data: {
        threadId,
        agentId: streamAgentId,
        // WHICH turn: a newer request to the same agent can start a second
        // turn while this one still runs (a demo visitor's replaces it), and
        // a client keeps one live block per turn (the reply names it too).
        turnId: liveTurnId,
        // The person's message the turn answers (the trigger, or the ask an
        // approved call's handed-back turn continues).
        askId: result.askId ?? result.userMessageId,
        // The reply thread the streaming answer lands in, so a client draws
        // it in the open panel rather than under the channel.
        replyRootId: result.replyRootId ?? null,
        ...data,
        ...frame,
        ...(accumulatedScopes ? { accumulatedScopes } : {}),
      },
    }).catch((err) =>
      log.error({ err, threadId, action }, "Failed to broadcast agent_stream event"),
    )

  const emitStreamEvent = (action: string, data: Record<string, unknown> = {}) => {
    // A fenced runner's frames would interleave with the new owner's (M1).
    if (result.turnFenced()) return
    // A handed-off turn is not over: the resume continues its live entry.
    if ((action === "done" || action === "error") && turnHandedOff) return
    // A2: the fan-out gates each chunk on the scopes this turn has accumulated
    // BY NOW (`websocket.ts` `hasStreamChunkAccess`), so the snapshot is read
    // here, per chunk, and never hoisted out of this closure: the set grows as
    // the turn's tool calls are recorded, and a value captured at stream start
    // would tag a post-tool-call chunk with the empty set it had before.
    //
    // A caller-supplied stand-in for runAgentChat (AgentServiceTestAccess.setAgentRun) exposes
    // no accumulator, and there the chunk stays UNTAGGED rather than claiming
    // `[]`: the turn's set is genuinely unknown, and the fan-out's fail-closed
    // default (requester only) is the honest answer.
    const accumulatedScopes =
      typeof result.turnAccumulatedScopes === "function"
        ? result.turnAccumulatedScopes()
        : undefined
    // Registry first: late-joining thread views seed the in-flight run from
    // GET /api/agent/stream-state/:threadId, then follow the WS deltas. It
    // takes the SAME tag as the broadcast, because that replay is gated on the
    // tag exactly as each live chunk is.
    // WHICH agent is speaking, on the registry entry and on the frame. A room
    // that names two agents runs two turns at once (A29/A30), and keyed on the
    // thread alone the second one overwrote the first's live state and the
    // first's `done` wiped the second's: one live turn on screen, and the other
    // agent showing nothing at all.
    const streamAgentId = result.actingAgentId ?? null
    // The frame carries the `seq` and item the record allocated (S28), so the
    // broadcast waits for it. The registry records one turn's events in call
    // order, so the frames leave in `seq` order. A record Redis fails is still
    // broadcast, without `seq` (open: the live chunk is the room's, the replay
    // only loses it), and its gating is unchanged.
    const recorded = recordAgentStreamEvent(threadId, orgId, action, data, {
      requesterId: actor.userId,
      agentId: streamAgentId,
      turnId: liveTurnId,
      askId: result.askId ?? result.userMessageId,
      ...(accumulatedScopes ? { accumulatedScopes } : {}),
    }).catch((err: unknown): RecordedFrame | null => {
      log.warn({ err, threadId, action }, "Could not record an agent_stream frame")
      return null
    })
    streamSent = recorded.then((frame) =>
      broadcastStreamFrame(action, data, frame, streamAgentId, accumulatedScopes),
    )
  }

  // Track whether finalize() has been called so we never call it twice and
  // always call it at least once on every terminal path (finish, error, throw).
  let finalized = false
  let hardTokenLimitStopped = false
  // Set when finalize handed the turn off (a draining process): no "done".
  let turnHandedOff = false
  // Returned to this function's caller only; never broadcast to the room.
  let withheldCapabilities: string[] = []
  let text = ""
  // The stored reply: each step's text a paragraph of its own (reply-flatten.ts).
  const replyText = createReplyText()
  let reasoning = ""
  // What the room's sockets receive of the turn's text: in a shared thread only
  // the answer, never a step's notes before its tools (shared-thread-reply.ts).
  // A caller-supplied stand-in for runAgentChat that does not say is private.
  const liveText = createLiveTextGate(result.sharedThread === true, (delta) =>
    emitStreamEvent("delta", { delta }),
  )
  // Chronological interleave of reasoning runs and tool calls, in the exact order
  // the model emitted them. Reasoning deltas coalesce into the trailing reasoning
  // entry; a tool-call chunk closes the current run and starts a fresh one after,
  // so a tool invoked mid-thinking is anchored at its true position (not appended
  // after the whole thinking block). Persisted in metadata.timeline via finalize.
  const timeline: TurnTimelineEntry[] = []
  const steps: any[] = []
  // `promptTokens` is the SUM across steps (billing); `lastStepInputTokens` is
  // the FINAL step's input — the real context size the compaction trigger needs.
  const usage = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    // Provider-reported cache-hit input tokens (subset of promptTokens on
    // Google/OpenAI/Mistral). Observability for prompt-cache effectiveness +
    // cached-rate billing in finalizeUsage.
    cachedInputTokens: 0,
    // Provider-reported cache WRITE tokens (Anthropic's cache creation), from
    // providerMetadata.anthropic.cacheCreationInputTokens (G1). null means no
    // step ever reported one — distinct from a measured 0.
    cacheWriteTokens: null as number | null,
    cacheWrite5mTokens: null as number | null,
    // The USD cost the provider reported (OpenRouter), summed over the steps (step-usage.ts).
    providerCostUsd: undefined as number | null | undefined,
    lastStepInputTokens: 0,
  }
  // Declared at function scope so the `finally` safety-net finalize can read it.
  let finishReason = "stop"
  // Captured from an in-band `error` chunk (or a thrown stream) so the terminal
  // finalize can SURFACE the real cause in the chat message instead of a blank turn.
  let streamErrorDetail: string | null = null
  // The failing error's own string `code`, when it has one (a refusal's code).
  let streamErrorCode: string | null = null
  // Set when the failure is the provider having stopped answering, with no
  // re-run left: the stored line says so and says to continue.
  let streamErrorNotice: ProviderNoticeCode | null = null
  // The run's answer to a provider failure the stream met (onProviderFailure):
  // "retry" hands the turn off to run the cut step again, so nothing of the
  // failure is shown, persisted or finalized here.
  const providerFailure = (err: unknown): "retry" | "unavailable" | null =>
    result.onProviderFailure?.(err) ?? null

  async function finalizeOnce(params: {
    usage: {
      promptTokens: number
      completionTokens: number
      reasoningTokens?: number
      cachedInputTokens?: number
      cacheWriteTokens?: number | null
      /** The 5-minute-TTL part of cacheWriteTokens (step-usage.ts). */
      cacheWrite5mTokens?: number | null
      /** The USD cost the provider reported over every step (OpenRouter); null when one step reported none. */
      providerCostUsd?: number | null
      /** Input tokens of the run's FINAL step -- the real context size (compaction metric). */
      lastStepInputTokens?: number
    }
    finishReason: string
    text: string
    steps: Array<{
      toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }>
      toolResults?: Array<{ toolCallId: string; result: unknown }>
      /** One per `tool-error` chunk: a call that produced no result. Its detail is
       *  what keeps the persisted row from being a bare `status: "error"`. */
      toolErrors?: Array<{ toolCallId: string; error: unknown }>
    }>
  }): Promise<void> {
    if (finalized) return
    finalized = true
    // A turn handed off to run its cut step again ends nothing here.
    if (params.finishReason === "error" && !params.text.trim() && !result.turnHandoff()) {
      // The terminal finalize will surface `streamErrorDetail` as the message
      // content (see the finalize callback) so the failure shows in the chat
      // instead of a blank turn (BL-177). Log the structured cause once here.
      log.error(
        {
          threadId,
          messageId,
          finishReason: params.finishReason,
          errorDetail: streamErrorDetail,
          stepCount: params.steps.length,
        },
        "Agent turn errored with no text — surfacing the error in the chat message",
      )
    }
    try {
      // `reasoning` is accumulated in the stream loop below; attach it here so
      // every terminal path (finish / error / throw) persists it exactly once.
      const done = await result.finalize({
        ...params,
        errorDetail: streamErrorDetail ?? undefined,
        errorCode: streamErrorCode ?? undefined,
        ...(streamErrorNotice ? { errorNotice: streamErrorNotice } : {}),
        reasoning,
        timeline,
        stepTexts: replyText.steps,
      })
      withheldCapabilities = done?.withheldCapabilities ?? []
      if (done?.finishReason === HANDOFF_FINISH_REASON) turnHandedOff = true
      // A run the routine's hard token limit stopped (S17) reports it, so the
      // caller (the routine supervisor, an agents_ask wait) sees the stop
      // rather than the last step's "tool-calls".
      if (done?.finishReason === "hard_token_limit") hardTokenLimitStopped = true
    } catch (finalizeErr) {
      log.error({ err: finalizeErr, threadId, messageId }, "Agent finalize failed")
    }
  }

  try {
    let currentStep: any = { toolCalls: [], toolResults: [], toolErrors: [] }

    if (!resume) emitStreamEvent("start")
    // Where each step's frames end, so a resume drops a cut step's (M1).
    const priorStepCount = resume?.steps.length ?? 0
    const markStep = (n: number) =>
      void markAgentStreamStepBoundary(threadId, result.actingAgentId ?? null, liveTurnId, n).catch(
        (err: unknown) => log.warn({ err, threadId }, "Could not mark a step boundary"),
      )
    if (!resume) markStep(0)
    // `start` replaced the accepted entry (same agent, same turn); if it named
    // another agent the accepted one would linger beside it.
    void withdrawAccepted()

    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") {
        replyText.add(chunk.text)
        text = replyText.text
        const lastText = timeline[timeline.length - 1]
        if (lastText?.kind === "text") lastText.text += chunk.text
        else timeline.push({ kind: "text", text: chunk.text })
        liveText.text(chunk.text)
      } else if (chunk.type === "reasoning-delta") {
        // Reasoning text (full or summary, per provider) streams ahead of the
        // answer; surface it as a distinct WS action for the thinking block.
        reasoning += chunk.text
        const lastEntry = timeline[timeline.length - 1]
        if (lastEntry?.kind === "reasoning") lastEntry.text += chunk.text
        else timeline.push({ kind: "reasoning", text: chunk.text })
        emitStreamEvent("reasoning", { delta: chunk.text })
      } else if (chunk.type === "tool-call") {
        // Lazy-init the step bundle id on the first tool call in this step. We
        // read PARALLEL_APPROVAL_BUNDLING from process.env directly (not
        // env.PARALLEL_APPROVAL_BUNDLING) so tests can flip the flag per-case
        // without restarting the process — env.ts caches at module load. envFlag
        // is the same strict parser env.ts uses, so the two reads always agree.
        if (envFlag("PARALLEL_APPROVAL_BUNDLING") && result.stepCtx.stepBundleId === null) {
          result.stepCtx.stepBundleId = crypto.randomUUID()
        }
        // Invariant K, the ARGS half. Redact ONCE and let both consumers read
        // the same value, exactly as the tool-result branch below does:
        // `currentStep.toolCalls` is what `extractToolCalls` persists into
        // `kernel.messages.metadata`, and the stream event is what
        // `recordAgentStreamEvent` replays and `broadcastEphemeral` puts on the
        // wire. A gated `mail__reply` seals its body into the approval payload,
        // so writing that same cleartext here would make the seal worth nothing
        // against an org admin or the operator. Every non-mail call passes
        // through by reference, unchanged.
        const persistableArgs = await redactMailToolArgs(orgId, chunk.toolName, chunk.input)
        const presentation = toolCallPresentation(orgId, chunk.toolName)
        currentStep.toolCalls.push({
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          args: persistableArgs,
          ...presentation,
          ...replayableProviderMetadata(chunk.providerMetadata),
        })
        timeline.push({ kind: "tool", toolCallId: chunk.toolCallId, step: steps.length })
        liveText.toolCall()
        emitStreamEvent("tool_call", {
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          args: persistableArgs,
          ...presentation,
          ...uiEffectRequester(chunk.toolName, actor.userId),
        })
      } else if (chunk.type === "tool-result") {
        // Invariant K, Task 6.6. Redact ONCE, here, and let both consumers read
        // the same value: `currentStep.toolResults` is what `extractToolCalls`
        // later persists into `kernel.messages.metadata`, and the stream event
        // below is what `recordAgentStreamEvent` puts in the replay buffer and
        // `broadcastEphemeral` puts on the wire. Redacting at only one of them
        // leaves the other leaking, and redacting them separately lets the two
        // drift. Every non-mail result passes through by reference, unchanged.
        // Resolve the tool name from the matching tool-call rather than trusting
        // the result chunk to carry one: an unnamed result would otherwise skip
        // the mail branch entirely and pass through unredacted.
        const resultToolName =
          (chunk as { toolName?: string }).toolName ??
          (currentStep.toolCalls as Array<{ toolCallId: string; toolName: string }>).find(
            (tc) => tc.toolCallId === chunk.toolCallId,
          )?.toolName ??
          ""
        const persistableResult = await redactMailToolResult(orgId, resultToolName, chunk.output)
        // The card reads the redacted result too, so a sealed value never reaches it.
        const cardFields = await toolCardFieldsForResult(
          orgId,
          resultToolName,
          persistableResult,
          chunk.output,
        )
        currentStep.toolResults.push({
          toolCallId: chunk.toolCallId,
          result: persistableResult,
          ...cardFields,
        })
        emitStreamEvent("tool_result", {
          toolCallId: chunk.toolCallId,
          result: persistableResult,
          ...cardFields,
        })
      } else if (chunk.type === "tool-error") {
        // The AI SDK emits this INSTEAD of a tool-result when the call never
        // produced one (schema-invalid input, unknown tool, a throw that escaped
        // the tool bridge). Without this branch the detail died here and the turn
        // persisted a bare `{ result: null, status: "error" }`. Log it with the
        // same context a field bug report needs, persist the safe envelope, and
        // put that envelope on the wire so the live surface shows the real reason.
        const failed = toPersistableToolError(chunk.error)
        log[toolErrorLogLevel(chunk.error)](
          {
            err: chunk.error,
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            code: failed.code,
            status: failed.status,
            threadId,
            orgId,
          },
          "Agent tool call errored",
        )
        const errorCardFields = toolCardFieldsForError(orgId, chunk.toolName)
        currentStep.toolErrors.push({
          toolCallId: chunk.toolCallId,
          error: chunk.error,
          ...errorCardFields,
        })
        emitStreamEvent("tool_result", {
          toolCallId: chunk.toolCallId,
          result: { error: failed },
          ...errorCardFields,
        })
      } else if (chunk.type === "finish-step") {
        replyText.endStep()
        const step = readStepUsage(chunk.usage)
        usage.promptTokens += step.inputTokens ?? 0
        usage.completionTokens += step.outputTokens ?? 0
        usage.reasoningTokens += step.reasoningTokens
        usage.cachedInputTokens += step.cacheReadTokens
        // G1: cache creation (write) tokens, reported by Anthropic. Absent means
        // the provider reported nothing this step, kept distinct from a measured 0.
        if (step.cacheWriteTokens !== undefined) {
          usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + step.cacheWriteTokens
        }
        if (step.cacheWrite5mTokens !== undefined) {
          usage.cacheWrite5mTokens = (usage.cacheWrite5mTokens ?? 0) + step.cacheWrite5mTokens
        }
        usage.providerCostUsd = addProviderCostUsd(usage.providerCostUsd, chunk.providerMetadata)
        // Keep the LAST step's input tokens — the true context size for compaction.
        // A step the answer-after-tools middleware re-issued bills both calls;
        // its context is the answering request's own input.
        const contextTokens = stepContextInputTokens(step.inputTokens, chunk.providerMetadata)
        if (contextTokens !== undefined) {
          usage.lastStepInputTokens = contextTokens
        }
        if (chunk.finishReason) finishReason = chunk.finishReason
        steps.push({ ...currentStep })
        markStep(priorStepCount + steps.length)
        currentStep = { toolCalls: [], toolResults: [], toolErrors: [] }
        // Reset step bundle id for the next step.
        result.stepCtx.stepBundleId = null
        liveText.stepFinished()
      } else if (chunk.type === "error") {
        const verdict = providerFailure(chunk.error)
        // Handed off: the turn runs this step again from the last complete
        // one, and the resume rewinds the live frames of the cut step.
        if (verdict === "retry") continue
        if (verdict === "unavailable") streamErrorNotice = "provider_unavailable"
        const message =
          chunk.error instanceof Error
            ? chunk.error.message
            : typeof chunk.error === "object" && chunk.error !== null && "message" in chunk.error
              ? String((chunk.error as any).message)
              : "Agent stream failed"
        // What the turn stores is sent first, so the live block matches the row.
        liveText.flush()
        emitStreamEvent("error", { message })
        // Capture the error for the terminal finalize so it SURFACES in the chat
        // message (not just this WS event). This branch previously had no log.error,
        // so a provider/tool stream error was swallowed — only a WS event + an empty
        // persisted message (the BL-177 spend-cap blank-turn class). Serialize richly.
        streamErrorDetail = message
        streamErrorCode = errorCodeOf(chunk.error)
        log.error(
          {
            threadId,
            messageId,
            inbandError: serializeStreamError(chunk.error),
            textLen: text.length,
            stepCount: steps.length,
          },
          "Agent stream in-band error",
        )
        // Finalize on every in-band error, even when no text accumulated yet.
        // In AI SDK v6 a provider/tool error mid-stream is emitted as an in-band
        // `error` part and the stream then ends WITHOUT a `finish` part, so this
        // branch is the only terminal signal — guarding it on `text` would skip
        // persistence/credit deduction/clearTimeout for errors before any output.
        finishReason = "error"
        await finalizeOnce({ usage, finishReason: "error", text, steps })
      } else if (chunk.type === "finish") {
        // Write the resolved reason back to function scope so a bare `finish`
        // chunk (no preceding `finish-step`) is still surfaced to the caller.
        finishReason = chunk.finishReason ?? finishReason
        liveText.flush()
        await finalizeOnce({
          usage,
          finishReason,
          text,
          steps,
        })
        emitStreamEvent("done", { finishReason })
      }
    }
  } catch (err) {
    // A read the provider broke off (a dropped connection) throws instead of
    // sending an error part; handed off, the `finally` below finalizes the
    // handoff and nothing of the failure is shown.
    const verdict = providerFailure(err)
    if (verdict !== "retry") {
      if (verdict === "unavailable" && streamErrorDetail === null) {
        streamErrorNotice = "provider_unavailable"
      }
      const message = err instanceof Error ? err.message : "Agent stream failed"
      liveText.flush()
      emitStreamEvent("error", { message })
      if (streamErrorDetail === null) streamErrorCode = errorCodeOf(err)
      streamErrorDetail = streamErrorDetail ?? message
      log.error({ err, threadId, messageId }, "invokeAgentForThread stream failed")
      // Ensure the timer is cleared and any partial content persisted even when
      // the stream throws rather than emitting an error chunk.
      // (finalizeOnce is idempotent — safe to call here regardless of whether
      // an earlier error chunk already triggered it.)
      finishReason = "error"
      await finalizeOnce({ usage, finishReason: "error", text, steps })
    }
  } finally {
    // Safety net: if the stream ended without any terminal chunk (no `finish`,
    // no in-band `error`, no throw — e.g. the internal timeout abort), still
    // finalize so the invariant "finalize runs at least once on every terminal
    // path" holds. Idempotent — a no-op when an earlier branch already
    // finalized.
    liveText.flush()
    await finalizeOnce({ usage, finishReason, text, steps })
    // Terminal stream event on the same paths: without it a timeout-aborted
    // run leaves live thread views "streaming" until the persisted message
    // lands, and the stream-state registry entry would go stale. A duplicate
    // `done` after the finish-chunk path is harmless (idempotent client-side).
    if (finishReason !== "error") emitStreamEvent("done", { finishReason })
    await streamSent
    broadcastEphemeral({
      app: "kernel",
      entity: "typing",
      action: "stop",
      entityId: threadId,
      orgId,
      actorId: actor.userId,
      actorType: "agent",
      // H6: the same agent the typing:start frame named.
      data: {
        authorType: "agent",
        userId: actor.userId,
        agentId: result.actingAgentId ?? null,
        ...(result.replyRootId ? { replyRootId: result.replyRootId } : {}),
      },
    }).catch((err) => log.error({ err, threadId }, "Failed to broadcast typing:stop"))
  }
  // Surface the resolved run outcome to the caller (the routine supervisor reads
  // `finishReason` to decide continue-vs-stop and sums `turnsAdded`). A bare
  // single-step turn reports ≥1 so the supervisor never sees a zero-turn run.
  // This replaces the fictional `turnsAdded: 1` constant at the kernel-jobs callsite.
  return {
    finishReason: hardTokenLimitStopped ? "hard_token_limit" : finishReason,
    turnsAdded: Math.max(1, steps.length),
    withheldCapabilities,
  }
}

/**
 * Share anyway's rerun (spec-security.md D4): answers `turnId` again as
 * `agentId` at exactly `effectiveScope`, and returns the reply instead of
 * persisting it, so the caller writes it with its disclosure list. Nothing is
 * streamed or broadcast to the room. No database transaction is held across the
 * model call: each read and write inside is its own short transaction.
 */
export async function rerunAgentTurn(input: {
  orgId: string
  threadId: string
  turnId: string
  requesterId: string
  agentId: string
  effectiveScope: string[]
}): Promise<AgentTurnReply> {
  const { orgId, threadId, turnId, requesterId, agentId, effectiveScope } = input
  const { permissions, threadRow } = await withPrivilegedDb(
    orgId,
    "share-anyway-rerun-actor",
    async (tx) => {
      const permissions = await loadEffectivePermissions(tx, requesterId, orgId)
      const [threadRow] = await tx
        .select({
          agentModelId: threads.agentModelId,
          agentReasoningLevels: threads.agentReasoningLevels,
        })
        .from(threads)
        .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
        .limit(1)
      return { permissions, threadRow }
    },
  )
  const modelId = threadRow?.agentModelId ?? null
  const reasoningLevels = (threadRow?.agentReasoningLevels ?? {}) as Record<string, ReasoningLevel>

  const chat = await runAgentChat({
    threadId,
    content: "",
    modelId,
    reasoningLevel: modelId ? (reasoningLevels[modelId] ?? null) : null,
    actor: {
      actorType: "user",
      userId: requesterId,
      orgId,
      scopes: permissions.scopes,
      dimensionGrants: permissions.dimensionGrants,
      // The requester's roles too: a document shared with one of their roles
      // is part of what the rerun may read, exactly as in their own turn.
      roles: permissions.roles,
    },
    orgId,
    skipUserPersist: true,
    userMessageId: turnId,
    scopeOverride: { agentId, effectiveScope },
    persistReply: false,
    // D4 product decision: the rerun ANSWERS, it does not act. Replaying the
    // turn's writes would duplicate whatever it already did.
    readOnlyTools: true,
  })

  let text = ""
  const replyText = createReplyText()
  // The text after the last tool call: what a shared room receives (shared-thread-reply.ts).
  let finalStepText = ""
  let finishReason = "stop"
  let errorDetail: string | undefined
  const usage = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    // G1: see the identical accumulation in invokeAgentForThread above.
    cacheWriteTokens: null as number | null,
    cacheWrite5mTokens: null as number | null,
    // The USD cost the provider reported (OpenRouter), summed over the steps (step-usage.ts).
    providerCostUsd: undefined as number | null | undefined,
    lastStepInputTokens: 0,
  }
  const steps: Array<{
    toolCalls: Array<{
      toolCallId: string
      toolName: string
      args: unknown
      providerMetadata?: ToolCallProviderMetadata
    }>
    toolResults: Array<{ toolCallId: string; result: unknown }>
  }> = []
  let currentStep: (typeof steps)[number] = { toolCalls: [], toolResults: [] }
  try {
    for await (const chunk of chat.fullStream) {
      if (chunk.type === "text-delta") {
        replyText.add(chunk.text)
        text = replyText.text
        finalStepText += chunk.text
      } else if (chunk.type === "tool-call") {
        finalStepText = ""
        // Same redaction as the room path: the reply's metadata is persisted.
        currentStep.toolCalls.push({
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          args: await redactMailToolArgs(orgId, chunk.toolName, chunk.input),
          ...toolCallPresentation(orgId, chunk.toolName),
          ...replayableProviderMetadata(chunk.providerMetadata),
        })
      } else if (chunk.type === "tool-result") {
        const toolName =
          (chunk as { toolName?: string }).toolName ??
          currentStep.toolCalls.find((tc) => tc.toolCallId === chunk.toolCallId)?.toolName ??
          ""
        const redacted = await redactMailToolResult(orgId, toolName, chunk.output)
        currentStep.toolResults.push({
          toolCallId: chunk.toolCallId,
          result: redacted,
          ...(await toolCardFieldsForResult(orgId, toolName, redacted, chunk.output)),
        })
      } else if (chunk.type === "finish-step") {
        replyText.endStep()
        const step = readStepUsage(chunk.usage)
        usage.promptTokens += step.inputTokens ?? 0
        usage.completionTokens += step.outputTokens ?? 0
        usage.reasoningTokens += step.reasoningTokens
        usage.cachedInputTokens += step.cacheReadTokens
        if (step.cacheWriteTokens !== undefined) {
          usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + step.cacheWriteTokens
        }
        if (step.cacheWrite5mTokens !== undefined) {
          usage.cacheWrite5mTokens = (usage.cacheWrite5mTokens ?? 0) + step.cacheWrite5mTokens
        }
        usage.providerCostUsd = addProviderCostUsd(usage.providerCostUsd, chunk.providerMetadata)
        // A step the answer-after-tools middleware re-issued bills both calls;
        // its context is the answering request's own input.
        const contextTokens = stepContextInputTokens(step.inputTokens, chunk.providerMetadata)
        if (contextTokens !== undefined) {
          usage.lastStepInputTokens = contextTokens
        }
        if (chunk.finishReason) finishReason = chunk.finishReason
        steps.push(currentStep)
        currentStep = { toolCalls: [], toolResults: [] }
      } else if (chunk.type === "error") {
        finishReason = "error"
        errorDetail = chunk.error instanceof Error ? chunk.error.message : "the rerun stream failed"
        log.error(
          { threadId, turnId, inbandError: serializeStreamError(chunk.error) },
          "Share anyway rerun in-band error",
        )
      } else if (chunk.type === "finish") {
        finishReason = chunk.finishReason ?? finishReason
      }
    }
  } catch (err) {
    finishReason = "error"
    errorDetail = err instanceof Error ? err.message : "the rerun stream failed"
    log.error({ err, threadId, turnId }, "Share anyway rerun stream failed")
  }

  const done = await chat.finalize({
    usage,
    finishReason,
    text,
    stepTexts: replyText.steps,
    finalStepText,
    steps,
    errorDetail,
  })
  // A failed rerun shares nothing: an error line is not the answer the requester asked to share.
  if (finishReason === "error" || !done.reply) {
    throw new ShareAnywayError(
      "E_SHARE_ANYWAY_RERUN_FAILED",
      errorDetail ?? "the rerun produced no reply",
    )
  }
  return done.reply
}

// A user-facing line for a turn that STOPPED with no text but did not error:
// the internal timeout fired mid-loop, credits ran out, or the model was still
// requesting tools when the loop ended. Persisted as the message content so the
// thread shows an honest stop instead of a blank agent bubble.
function userFacingIncompleteTurn(
  finishReason: string,
  stepCount: number,
  /** The deadline in words (`TurnDeadline.describe`): "this run's limit is 300s …". */
  limit: string,
): string {
  const work =
    stepCount > 0
      ? `I completed ${stepCount} tool ${stepCount === 1 ? "call" : "calls"} before stopping; that work is preserved above.`
      : ""
  if (finishReason === "timeout") {
    return [
      `⚠️ I ran out of time before I could write a final answer (${limit}).`,
      work,
      "Ask me to continue and I will pick up from what I already gathered.",
    ]
      .filter(Boolean)
      .join(" ")
  }
  if (finishReason === "credits_exhausted") {
    return [
      "⚠️ Credits ran out before I could finish this response.",
      work,
      "Add credits and ask me to continue.",
    ]
      .filter(Boolean)
      .join(" ")
  }
  if (finishReason === "token_budget_exceeded") {
    return [
      "⚠️ This run consumed an abnormally large amount of context and was stopped by the runaway safeguard.",
      work,
      "This usually means a step kept failing and retrying; the failure details are in the tool results above. An operator has been notified.",
    ]
      .filter(Boolean)
      .join(" ")
  }
  return [
    `⚠️ I stopped before writing a final answer (stop reason: ${finishReason}).`,
    work,
    "Ask me to continue and I will pick up from what I already gathered.",
  ]
    .filter(Boolean)
    .join(" ")
}

// A user-facing message for a turn that errored, so the chat shows the failure
// instead of a blank agent bubble: the fixed English line of the failure's CLASS,
// then the failure's own detail made safe to show (no stack, secrets masked,
// bounded; `agentNoticeStoredText`). The class rides on metadata.agentNotice, so
// every surface renders the line in its reader's language; a one-line summary (Home
// preview, notification row, digest) shows the line alone, the conversation shows
// it with the detail. Never the generic line alone when the detail is known.
function userFacingAgentError(detail: string | null, notice?: ProviderNoticeCode): string {
  return agentNoticeStoredText(detail, notice)
}

/** An error's own string `code` (bounded), or null when it has none. */
function errorCodeOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("code" in err)) return null
  const code = (err as { code?: unknown }).code
  return typeof code === "string" && code.trim() ? code.trim().slice(0, 100) : null
}

// Richly serialize a stream error / tool result for the structured log — provider +
// AI-SDK errors nest the real signal in cause/data/responseBody/status, which a bare
// `String(err)` or `err.message` drops (conventions: field-level error observability).
export function serializeStreamError(err: unknown): unknown {
  if (err == null) return err
  if (err instanceof Error) {
    const anyErr = err as any
    return {
      name: err.name,
      message: err.message,
      statusCode: anyErr.statusCode ?? anyErr.status,
      code: anyErr.code,
      data: anyErr.data,
      responseBody: anyErr.responseBody ?? anyErr.body,
      // Provider 400s (e.g. Gemini's bare "Request contains an invalid
      // argument.") name no offending field — the request body the SDK sent is
      // the only way to see WHAT was invalid. Clipped: enough to locate the
      // malformed element without flooding the log stream.
      url: anyErr.url,
      requestBody: (() => {
        const rb = anyErr.requestBodyValues
        if (rb == null) return undefined
        try {
          const s = JSON.stringify(rb)
          return s.length > 200_000 ? `${s.slice(0, 200_000)}…[clipped ${s.length} chars]` : s
        } catch {
          return "[unserializable]"
        }
      })(),
      cause: anyErr.cause ? serializeStreamError(anyErr.cause) : undefined,
      stack:
        typeof err.stack === "string" ? err.stack.split("\n").slice(0, 4).join(" | ") : undefined,
    }
  }
  if (typeof err === "object") {
    try {
      return JSON.parse(JSON.stringify(err))
    } catch {
      return String(err)
    }
  }
  return err
}

/**
 * Invariant K note. Both the `args` and the `result` values reaching here are
 * ALREADY redacted: the only writer of `step.toolCalls` is the `tool-call`
 * branch of the stream loop, which calls `redactMailToolArgs` before pushing,
 * and the only writer of `step.toolResults` is the `tool-result` branch, which
 * calls `redactMailToolResult`. Redacting a second time here would double the
 * account lookups and, worse, would make it look as though either site alone
 * were sufficient. If a second writer of either array is ever added, it must
 * redact at ITS push, not here.
 */
/**
 * The safe, persistable envelope for a failed tool call. Error reporting
 * (apps/api/CLAUDE.md, BINDING): a bare `{ result: null, status: "error" }` tells
 * nobody what broke, so the real message plus the typed `code`/`status` ride along.
 * The upstream `body` deliberately does NOT: it is log-only (tool-bridge logs it
 * with full context), because it can carry the third party's raw payload and this
 * envelope is persisted on the message and replayed into the agent's context.
 */
export function toPersistableToolError(error: unknown): {
  message: string
  code?: string
  status?: number
} {
  const e = error as { code?: unknown; status?: unknown; statusCode?: unknown }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error) ?? "unknown tool error"
            } catch {
              return String(error)
            }
          })()
  const code = typeof e?.code === "string" ? e.code : undefined
  const status =
    typeof e?.status === "number"
      ? e.status
      : typeof e?.statusCode === "number"
        ? e.statusCode
        : undefined
  return {
    message: message || "unknown tool error",
    ...(code ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
  }
}

/** A tool call's provider metadata, as the provider handed it with the call. */
type ToolCallProviderMetadata = Record<string, Record<string, unknown>>

/**
 * The provider metadata a tool call must carry when its turn is replayed, or nothing.
 *
 * Gemini signs each function call it makes (`google.thoughtSignature`, its reasoning state) and
 * expects the signature back when the call is sent again in a later request. The persisted call
 * used to keep only id, name and args, so every replay came back unsigned: the AI SDK warned
 * ("Replayed N functionCall part(s) ... without a thoughtSignature") and sent a skip sentinel, and
 * the model lost its reasoning chain across steps. The metadata is stored with the call and
 * replayed as the part's `providerOptions` (context.ts, convertToCoreMessages).
 */
function replayableProviderMetadata(
  providerMetadata: unknown,
): { providerMetadata: ToolCallProviderMetadata } | Record<string, never> {
  if (!providerMetadata || typeof providerMetadata !== "object") return {}
  const kept = Object.fromEntries(
    Object.entries(providerMetadata as Record<string, unknown>).filter(
      ([, v]) => v !== null && typeof v === "object" && Object.keys(v).length > 0,
    ),
  ) as ToolCallProviderMetadata
  return Object.keys(kept).length > 0 ? { providerMetadata: kept } : {}
}

function extractToolCalls(
  steps: Array<{
    toolCalls?: Array<
      {
        toolCallId: string
        toolName: string
        args: unknown
        providerMetadata?: ToolCallProviderMetadata
      } & ToolCallPresentation
    >
    toolResults?: Array<{ toolCallId: string; result: unknown } & ToolCardFields>
    toolErrors?: Array<{ toolCallId: string; error: unknown } & ToolCardFields>
  }>,
  /** The turn's calls that marked it as having read outside text; absent: not recorded. */
  taintedToolCallIds?: ReadonlySet<string>,
): Array<
  {
    toolCallId: string
    toolName: string
    args: unknown
    result: unknown
    status: "completed" | "error"
    error?: { message: string; code?: string; status?: number }
    providerMetadata?: ToolCallProviderMetadata
    tainted?: boolean
  } & ToolCallPresentation &
    ToolCardFields & { cardSuperseded?: true }
> {
  const calls = steps.flatMap((step) =>
    (step.toolCalls ?? []).map((tc) => {
      // A tool that errors in AI SDK v6 emits a `tool-error` chunk and never
      // produces a matching toolResult, so the entry is absent. Distinguish that
      // (status "error") from a tool that ran and returned a literal `null`
      // (status "completed") by checking for the entry's presence, not its value.
      const tr = step.toolResults?.find((r) => r.toolCallId === tc.toolCallId)
      const te = step.toolErrors?.find((r) => r.toolCallId === tc.toolCallId)
      return {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
        ...(tc.providerMetadata ? { providerMetadata: tc.providerMetadata } : {}),
        // Reload draws what the live row drew (never replayed: `convertToCoreMessages` names
        // the fields a replay sends, and none of these is one).
        ...(tc.readOnly !== undefined ? { readOnly: tc.readOnly } : {}),
        ...(tc.appLabel ? { appLabel: tc.appLabel } : {}),
        ...(tc.runningLabel ? { runningLabel: tc.runningLabel } : {}),
        ...(tc.runningLabelKey ? { runningLabelKey: tc.runningLabelKey } : {}),
        ...(tr?.card ? { card: tr.card } : {}),
        ...((tr?.cardError ?? te?.cardError) ? { cardError: tr?.cardError ?? te?.cardError } : {}),
        result: tr?.result ?? null,
        status: tr === undefined ? ("error" as const) : ("completed" as const),
        // Present only on the failing half: a completed call has nothing to say here,
        // and a failure with no captured chunk still reads as a failure rather than
        // silently gaining an empty error object.
        ...(tr === undefined && te ? { error: toPersistableToolError(te.error) } : {}),
        // What a later turn replaying this call is judged by (scopes/replayed-outside-text.ts).
        ...(taintedToolCallIds ? { tainted: taintedToolCallIds.has(tc.toolCallId) } : {}),
      }
    }),
  )
  return markSupersededWithinTurn(calls)
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const AgentServiceTestAccess = {
  /** Shorten the default progress deadline (turn-deadline.ts); no argument restores it. */
  setTurnDeadline(limits?: { stepMs: number; ceilingMs: number }): void {
    if (!isTestEnv()) {
      throw new Error("AgentServiceTestAccess.setTurnDeadline is only available in tests")
    }
    defaultTurnDeadline = limits ?? { stepMs: TIMEOUT_MS, ceilingMs: TURN_PROGRESS_CEILING_MS }
  },
  /** The persisted shape of a turn's tool calls (the metadata a replay reads back). */
  extractToolCalls,
  /** What a streamed tool call keeps of its provider metadata for the replay. */
  replayableProviderMetadata,

  /**
   * Swap the AI SDK `streamText` the agent loop drives; pass nothing to restore.
   * Only swappable when isTestEnv() (see lib/env.ts for the shared predicate;
   * both Bun's runtime quirks and the test-runner argv are checked there).
   */
  setStreamText(fn?: typeof streamText): void {
    if (!isTestEnv()) {
      throw new Error("AgentServiceTestAccess.setStreamText is only available in tests")
    }
    streamTextForAgent = fn ?? streamText
  },

  /**
   * Swap the `runAgentChat` entrypoint `getRunAgentChat()` hands out. A stand-in
   * returns the parts of an AgentChatResult its test cares about; the turn-record
   * accessors every caller reads (`turnFenced`, `turnHandoff`, since the turn
   * journal) default to a turn that is neither fenced nor handed off, unless the
   * stand-in returns its own.
   */
  setAgentRun(fn?: (params: any) => Promise<any>): void {
    if (!isTestEnv()) {
      throw new Error("AgentServiceTestAccess.setAgentRun is only available in tests")
    }
    runAgentChatForTest = fn
      ? async (params: any) => ({
          turnFenced: () => false,
          turnHandoff: () => false,
          ...(await fn(params)),
        })
      : undefined
  },
}
