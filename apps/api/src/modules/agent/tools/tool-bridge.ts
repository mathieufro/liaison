// SPDX-License-Identifier: FSL-1.1-ALv2
import { findRefTokens } from "@liaison/shared"
import { tool } from "ai"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { ActorContext } from "~/db/rls"
import { EffectInFlight, effectOnce } from "~/lib/effect-once"
import { logFailure } from "~/lib/failure-severity"
import { rootLogger } from "~/lib/logger"
import { isRetrievalTool, MAX_MEMORY_CALLS_PER_TURN } from "~/modules/agent/context/cold-resume"
import { redactMailToolResult } from "~/modules/agent/mailbox-plaintext/mail-plaintext-redaction"
import {
  fulfilMailboxMarker,
  readMailboxMarker,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-broker"
import {
  toModelInputSchema,
  toProviderSafeInputSchema,
} from "~/modules/agent/providers/provider-schema"
import { checkReadOnlyRun, isReadOnlyTool } from "~/modules/agent/runtime/read-only-run"
import { truncateToolResultForModel } from "~/modules/agent/runtime/result-truncation"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import {
  currentRunContext,
  runContextStore,
  runWithToolCallScopesBefore,
} from "~/modules/agent/runtime/run-context"
import { turnToolScopes } from "~/modules/agent/scopes/effective-scope"
import { checkToolScopes } from "~/modules/agent/scopes/required-scopes"
import {
  checkToolScopeTaint,
  isPlatformTaintRefusal,
  wasRefusedBeforeRun,
} from "~/modules/agent/scopes/scope-taint"
import { watchTaintMarks } from "~/modules/agent/scopes/taint"
import { isHostOnlyParam, stripHostOnlyParams } from "~/modules/agent/tools/host-only-params"
import { toJsonValue, toolFailureModelOutput } from "~/modules/agent/tools/tool-failure-output"
import { rememberHeldToolSet } from "~/modules/agent/tools/tool-name-resolve"
import { hiddenToolAliases } from "~/modules/agent/tools/tool-rank"
import { repeatFetchResult } from "~/modules/agent/tools/web-fetch-repeat"
import {
  approvalActionRequiredClause,
  gatedNotesRelay,
  sequencingRecipe,
} from "~/modules/approvals/agent-guidance"
import { resolveApprovalRef } from "~/modules/approvals/resolve-ref"
import { orgHasCapability, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { isAppOffForOrg, isAppUnavailableFor, isFeatureOffForTool } from "~/modules/apps/org-apps"
import { getHealthGate } from "~/modules/mcp-client/health-gate"
import { slugIndex } from "~/modules/mcp-client/slug-index"
import { hasScope } from "~/modules/permissions/permissions"

const log = rootLogger.child({ module: "tool-bridge" })

/**
 * THE PER TURN MEMORY CALL CAP (P4c-T25, spec-memory.md Budgets).
 *
 * MAX_MEMORY_CALLS_PER_TURN retrieval calls per turn, counted HERE because the
 * tool layer is the only place that both knows which turn a call belongs to and
 * can answer it without one: the count hangs off the turn's own run frame, so a
 * turn is a turn, a sub-run gets its own budget, and a frameless caller (the MCP
 * gateway) is not a turn at all and is never capped.
 *
 * The fourth call is REFUSED AS A RESULT, never thrown: the model reads the
 * refusal, can say what it does and does not know, and the turn still answers.
 */
const memoryCallsByFrame = new WeakMap<object, number>()

export const MEMORY_CALL_CAP_CODE = "E_MEMORY_CALL_CAP"

export type MemoryCallCapRefusal = {
  ok: false
  code: typeof MEMORY_CALL_CAP_CODE
  reason: "memory_call_cap"
  error: string
}

/**
 * The step context the agent loop shares with every tool's `execute`.
 * `answerOnly` is set for a step that must answer in words (a turn's budget
 * check-in, a routine run's pause): the step keeps its tools in the request,
 * so the provider's prompt cache still reads the turn's prefix (with
 * `toolChoice: "none"` some upstreams drop the tool list from the prompt and
 * OpenRouter may route the step to another upstream), and a call the model
 * makes anyway is not run; its result is this text.
 */
export interface StepContext {
  stepBundleId: string | null
  answerOnly?: string | null
  /**
   * Set while a routine run chains on a parked call (it proposes the steps of
   * one request before it pauses): only a call that parks for a decision runs
   * (`chainStepAdmits`); any other call is not run and its result is this text.
   */
  chainOnly?: string | null
}

/**
 * Whether a call may run while a routine run chains on a parked call: the
 * kernel's tool lookup (the next step's tool is often deferred and must be
 * found first), a tool that parks for a decision (gated, or gated by its own
 * handler), or a call citing an @ref token (staged as a step, never run). An
 * ungated write would run at once, before the person decides what it follows.
 */
export function chainStepAdmits(
  fullName: string,
  toolDef: { gated?: boolean; conditionalGate?: boolean },
  args: unknown,
): boolean {
  if (fullName === "kernel:tool_search") return true
  if (toolDef.gated === true || toolDef.conditionalGate === true) return true
  return findRefTokens(args).length > 0
}

/** A call made in an answer-only step: not run, and the model is told why. */
export const ANSWER_ONLY_STEP_CODE = "answer_only_step"

/** The code of a write whose outcome a crash left unknown (S10, B5). */
export const OUTCOME_UNKNOWN_CODE = "outcome_unknown"
export const OUTCOME_UNKNOWN_MESSAGE =
  "outcome unknown: this call may have taken effect; check before repeating it"

/**
 * What the model sees for a write the turn's earlier attempt started and never
 * finished (its process died mid-call): at most once, never run a second time.
 */
function outcomeUnknownResult() {
  return {
    ok: false as const,
    status: "failed" as const,
    code: OUTCOME_UNKNOWN_CODE,
    error: OUTCOME_UNKNOWN_MESSAGE,
  }
}

/** The code of a write another process is still running for this turn (S10, H2). */
export const EFFECT_IN_FLIGHT_CODE = "effect_in_progress"
export const EFFECT_IN_FLIGHT_MESSAGE =
  "in progress: this exact call is still running from before the answer moved to this server; do not repeat it, its result is not known yet"

/**
 * How long a resumed turn's write waits for the identical call its earlier
 * process is still finishing (the handoff lets running tools finish). Past
 * it the model gets the sticky in-progress answer, never a second run.
 */
let effectInFlightWaitMs = 10_000

export const ToolBridgeEffectTestAccess = {
  setInFlightWaitMs(ms: number | null): void {
    effectInFlightWaitMs = ms ?? 10_000
  },
}

function effectInFlightResult() {
  return {
    ok: false as const,
    status: "failed" as const,
    code: EFFECT_IN_FLIGHT_CODE,
    error: EFFECT_IN_FLIGHT_MESSAGE,
  }
}

function answerOnlyRefusal(reason: string) {
  return {
    ok: false as const,
    code: ANSWER_ONLY_STEP_CODE,
    reason: ANSWER_ONLY_STEP_CODE,
    error: reason,
  }
}

function memoryCallCapRefusal(): MemoryCallCapRefusal {
  return {
    ok: false,
    code: MEMORY_CALL_CAP_CODE,
    reason: "memory_call_cap",
    // Demo 2026-10-12: asked for 16 searches at once, the agent listed "limit
    // reached" as each refused word's result. This call never ran: say so.
    error:
      `This call was not run: you have already made ${MAX_MEMORY_CALLS_PER_TURN} memory calls ` +
      "this turn, which is the limit. Answer from what you found. Do not list the calls this " +
      "limit stopped as results: say once, in plain words, which ones you did not get to and " +
      "that you can run them in your next turn.",
  }
}

const FIELD_TYPE_MAP: Record<string, z.ZodTypeAny> = {
  string: z.string(),
  // `z.coerce.number()` accepts a numeric string ("2") as readily as a number
  // (2) — MCP arg transport (JSON over stdio/HTTP) can round-trip a number as
  // a string depending on the client, and without coercion Zod's plain
  // `z.number()` rejects the string outright ("Expected number, received
  // string"). Applies to every JSON-Schema `number`/`integer` param projected
  // from a manifest tool, not just knowledge:update's `revision` — the fix is
  // general, not a per-tool patch.
  number: z.coerce.number(),
  integer: z.coerce.number().int(),
  boolean: z.boolean(),
  any: z.any(),
}

/**
 * One JSON Schema node (a manifest tool's parameter) as Zod, KEEPING what a
 * model needs to call the tool right: the description, the enum, a nested
 * object's properties and required list, an array's items, and a nullable
 * type. The old projection kept the bare type only, so every tool reached the
 * provider (and the MCP tools/list) with `db_query.connection` stripped of its
 * ["default","warehouse"] enum and `kpi_run.period` as an empty object, and a
 * model picked the wrong connection on its first warehouse call.
 *
 * Numbers keep their coercion (an MCP client can send "2" for 2). A nested
 * object keeps unknown keys (it was `z.any()` before, and a handler may read
 * more than the manifest documents). What a provider cannot take is not this
 * function's concern: each provider adapter projects the JSON Schema to its
 * own dialect (Gemini's OpenAPI subset keeps description, enum, properties,
 * required, items and nullable), and `toProviderSafeInputSchema` normalizes the
 * one shape Gemini rejects outright.
 */
export function jsonSchemaToZod(def: unknown): z.ZodTypeAny {
  if (!def || typeof def !== "object" || Array.isArray(def)) return z.any()
  const node = def as Record<string, unknown>
  const declared = Array.isArray(node.type)
    ? (node.type as unknown[]).filter((t): t is string => typeof t === "string")
    : typeof node.type === "string"
      ? [node.type]
      : []
  const nullable = declared.includes("null")
  const types = declared.filter((t) => t !== "null")
  let out: z.ZodTypeAny
  const variants = Array.isArray(node.anyOf)
    ? node.anyOf
    : Array.isArray(node.oneOf)
      ? node.oneOf
      : null
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = node.enum as unknown[]
    if (values.every((v): v is string => typeof v === "string")) {
      out = z.enum(values as [string, ...string[]])
    } else {
      const literals = values
        .filter((v) => v === null || ["string", "number", "boolean"].includes(typeof v))
        .map((v) => z.literal(v as string | number | boolean | null))
      out =
        literals.length === 0
          ? z.any()
          : literals.length === 1
            ? (literals[0] as z.ZodTypeAny)
            : z.union(literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
    }
  } else if (variants && variants.length > 0) {
    const options = variants.map(jsonSchemaToZod)
    out =
      options.length === 1
        ? (options[0] as z.ZodTypeAny)
        : z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  } else if (types.length > 1) {
    const options = types.map((t) => jsonSchemaToZod({ ...node, type: t, description: undefined }))
    out = z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  } else {
    const type =
      types[0] ??
      (node.properties && typeof node.properties === "object"
        ? "object"
        : node.items
          ? "array"
          : "any")
    if (type === "object") {
      const props = (node.properties ?? {}) as Record<string, unknown>
      const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : [])
      const shape: Record<string, z.ZodTypeAny> = {}
      for (const [key, child] of Object.entries(props)) {
        const converted = jsonSchemaToZod(child)
        shape[key] = required.has(key) ? converted : converted.optional()
      }
      out = Object.keys(shape).length > 0 ? z.looseObject(shape) : z.record(z.string(), z.any())
    } else if (type === "array") {
      out = z.array(jsonSchemaToZod(node.items))
    } else {
      out = FIELD_TYPE_MAP[type] ?? z.any()
    }
  }
  if (nullable) out = out.nullable()
  if (typeof node.description === "string" && node.description.trim() !== "") {
    out = out.describe(node.description)
  }
  return out
}

function convertParams(params: unknown): z.ZodObject<any> {
  if (!params) return z.object({})

  // Zod schema — pass through
  if (typeof params === "object" && params !== null && "safeParse" in params) {
    return params as z.ZodObject<any>
  }

  // JSON Schema format (manifest tools): { type: "object", properties: { ... }, required?: [...] }
  if (
    typeof params === "object" &&
    params !== null &&
    "type" in params &&
    (params as any).type === "object" &&
    "properties" in params
  ) {
    // The top level stays a plain object (unknown top-level keys are dropped,
    // as they always were); every PROPERTY is converted faithfully, see
    // `jsonSchemaToZod`.
    const props = (params as any).properties as Record<string, unknown>
    const required = new Set((params as any).required ?? [])
    const shape: Record<string, z.ZodTypeAny> = {}
    for (const [key, def] of Object.entries(props)) {
      const base = jsonSchemaToZod(def)
      shape[key] = required.has(key) ? base : base.optional()
    }
    return z.object(shape)
  }

  // Field-map object (legacy: { fieldName: "string", ... })
  if (typeof params === "object" && params !== null) {
    const shape: Record<string, z.ZodTypeAny> = {}
    for (const [key, typeStr] of Object.entries(params as Record<string, string>)) {
      shape[key] = FIELD_TYPE_MAP[typeStr] ?? z.any()
    }
    return z.object(shape)
  }

  return z.object({})
}

/**
 * The provider-facing input schema of a tool's `params`, built once per params
 * object. Converting a manifest's JSON Schema to Zod and projecting it back
 * for the provider walked every tool's schema on every turn (a few hundred
 * tools a turn), the second-largest cost of building a tool set. A
 * registration's params never change after it is registered (a re-register
 * stores a new object), so the result is reused for as long as the
 * registration lives.
 */
const providerInputSchemas = new WeakMap<object, ReturnType<typeof toModelInputSchema>>()

/** The tool's parameters as a model or an MCP client may set them: no host-only parameter
 *  (host-only-params.ts), which only the bridge's own retry fills in. */
function modelFacingParams(params: unknown): z.ZodObject<any> {
  const zodObj = convertParams(params)
  const hidden = Object.keys(zodObj.shape as Record<string, unknown>).filter(isHostOnlyParam)
  if (hidden.length === 0) return zodObj
  return zodObj.omit(Object.fromEntries(hidden.map((key) => [key, true])))
}

export function providerInputSchemaOf(params: unknown): ReturnType<typeof toModelInputSchema> {
  if (typeof params !== "object" || params === null) {
    return toModelInputSchema(modelFacingParams(params))
  }
  let schema = providerInputSchemas.get(params)
  if (!schema) {
    schema = toModelInputSchema(modelFacingParams(params))
    providerInputSchemas.set(params, schema)
  }
  return schema
}

/** The same parameters as an external MCP client reads them, in full (`toModelInputSchema`). */
const gatewayInputSchemas = new WeakMap<object, ReturnType<typeof toProviderSafeInputSchema>>()

function gatewayInputSchemaOf(params: unknown): ReturnType<typeof toProviderSafeInputSchema> {
  if (typeof params !== "object" || params === null) {
    return toProviderSafeInputSchema(modelFacingParams(params))
  }
  let schema = gatewayInputSchemas.get(params)
  if (!schema) {
    schema = toProviderSafeInputSchema(modelFacingParams(params))
    gatewayInputSchemas.set(params, schema)
  }
  return schema
}

/**
 * Human-readable parameter summary for a tool, used when a model calls a
 * deferred tool it never loaded: the provider has never seen the schema, so the
 * error we return IS the schema — enough for the model to retry correctly on
 * the next step instead of re-guessing the same broken args.
 */
export function describeToolParams(params: unknown): string {
  const zodObj = modelFacingParams(params)
  const shape = zodObj.shape as Record<string, z.ZodTypeAny>
  const entries = Object.entries(shape)
  if (entries.length === 0) return "(no parameters)"
  return entries
    .map(([name, schema]) => {
      const required = !schema.isOptional()
      const desc = schema.description ? ` — ${schema.description}` : ""
      return `${name}${required ? " (required)" : ""}${desc}`
    })
    .join("; ")
}

/**
 * Detect a model stuck re-issuing the SAME failing call (tool + identical args)
 * and escalate the error wording. Weak models otherwise retry an unchanged call
 * until maxSteps (observed in prod: 14 identical 400s), because a plain error
 * string doesn't tell them that repeating it verbatim is the problem.
 * Returns a prefix to prepend from the 3rd identical failure on.
 */
function repeatedFailurePrefix(toolName: string, args: unknown, stepKey: string): string {
  const frame = runContextStore.getStore()
  if (!frame) return ""
  frame.toolFailureCounts ??= new Map()
  let key: string
  try {
    key = `${toolName}\0${JSON.stringify(args)}`
  } catch {
    key = toolName
  }
  const steps = recordFailureStep(frame.toolFailureCounts, key, stepKey)
  const count = steps.size
  if (count < 3) return ""
  return `STOP: this is your ${count}th attempt of this EXACT call with the EXACT same arguments, and it fails the same way every time. Do NOT retry it unchanged. Fix the arguments to satisfy the error below, or if you cannot, tell the user what you tried and what failed. `
}

/**
 * In how many distinct agent STEPS one tool may fail NON-RETRYABLY in a single
 * run before the bridge stops executing it. Keyed by toolName alone — the
 * crash-loop pattern observed in prod varies the ARGS each attempt (`#1846`,
 * `1846`, the Shopify gid…) while the cause (missing issuer profile,
 * structurally unsatisfiable precondition) is invariant, so the tool+args
 * counter never trips. Three steps in a row spent on a non-retryable error is
 * a loop, not progress.
 *
 * Counted per STEP, not per call: the parallel calls of one step are one model
 * decision. A model that fans a call out three times in one step and gets the
 * same refusal on each has made one mistake, and the corrected call of the next
 * step must run (observed live: three parallel creates missing the parent id
 * opened the breaker, and the corrected retry was refused, so nothing was made).
 */
const TERMINAL_FAILURE_LIMIT = 3

/**
 * A refusal because someone else moved the record on (two people editing one row):
 * the next call, made from a fresh read, can pass. Whatever the tool's envelope says,
 * it counts as retryable, so it never opens the breaker for the turn.
 */
const STALE_STATE_CODES: ReadonlySet<string> = new Set([
  "REVISION_CONFLICT",
  "stale_revision",
  "stale_run_hash",
])
const STALE_STATE_NEXT =
  " The record changed since you read it, so nothing was written. Read it again, then repeat the call with what you read."

/**
 * The step a tool call belongs to. The AI SDK passes every call of one step the
 * same `messages` (what the model was sent for that step), and each later step
 * sends a longer list, so its length names the step. A caller without it (the
 * MCP gateway, a direct execute) gets a key of its own per call: each call is
 * its own step, which is how every call was counted before.
 */
function toolStepKey(opts: { messages?: readonly unknown[] } | undefined): string {
  return opts?.messages ? `step:${opts.messages.length}` : `call:${crypto.randomUUID()}`
}

/** Adds `stepKey` to the steps `key` failed in; returns those steps. */
function recordFailureStep(
  store: Map<string, Set<string>>,
  key: string,
  stepKey: string,
): Set<string> {
  let steps = store.get(key)
  if (!steps) {
    steps = new Set()
    store.set(key, steps)
  }
  steps.add(stepKey)
  return steps
}

/**
 * Is this tool result a gated call PARKED for a human decision, rather than a
 * call that ran? A parked call executed no handler, so it read no org data and
 * taints nothing. Both gated seams ask this question of the shape they hold, so
 * both are answered here and the two can never disagree:
 *   `{ blocked: { reason, approvalRequestId, ... } }`  the executeTool envelope
 *                                                      (the MCP gateway)
 *   `{ blocked: true, status: "pending_approval" }`     the model-facing result
 *                                                      `executeWrapper` builds
 */
export function isParkedForApproval(result: unknown): boolean {
  if (result === null || typeof result !== "object") return false
  const r = result as { blocked?: unknown; status?: unknown }
  if (r.blocked !== null && typeof r.blocked === "object") return true
  return r.blocked === true && r.status === "pending_approval"
}

/**
 * What a gated call tells a ROUTINE run's agent. The run does not go on
 * without the call: it pauses after this step and resumes, in the same run,
 * with the call's real result once a person decides it (routine-run-resume.ts).
 * So the agent neither guesses the result nor carries on with work that needs it.
 */
export const ROUTINE_RUN_PAUSE_CLAUSE =
  "This routine run PAUSES until this request is decided, then resumes with its real result (or the refusal): do NOT guess what it would return. If a later call needs this result, make it now, in your next step, citing the token from `outputs` (that is how work that needs this result is proposed now). The run pauses as soon as you do anything else, so propose the whole chain first; then stop."

/**
 * Whether the calling turn holds `scope`: the run frame's effective scope
 * narrowed to the actor, the same set `buildToolSet` exposes tools from.
 */
function turnHoldsScope(actor: ActorContext, scope: string): boolean {
  return hasScope(scope, turnToolScopes(actor.scopes ?? [], runContextStore.getStore()))
}

async function executeWrapper(
  toolName: string,
  args: unknown,
  actor: ActorContext,
  orgId: string,
  threadId?: string,
  stepBundleId: string | null = null,
  /** The turn's stop for this call (the AI SDK's abortSignal). */
  signal?: AbortSignal,
  /** The agent step this call belongs to (`toolStepKey`). */
  stepKey: string = toolStepKey(undefined),
  /** The platform turned this call down before its handler ran: it read nothing. */
  onRefusedBeforeRun?: () => void,
): Promise<unknown> {
  // Circuit breaker: once a tool has failed non-retryably TERMINAL_FAILURE_LIMIT
  // times this run, refuse further calls to it without executing. The refusal is
  // cheap (no handler dispatch, no full-context step wasted on a doomed write)
  // and the message redirects the model instead of feeding it the same error.
  const terminalFrame = runContextStore.getStore()
  const terminalCount = terminalFrame?.toolTerminalFailures?.get(toolName)?.size ?? 0
  if (terminalCount >= TERMINAL_FAILURE_LIMIT) {
    log.warn(
      { toolName, terminalCount },
      "Agent tool call refused — terminal-failure circuit breaker open for this run",
    )
    return {
      error: `BLOCKED: ${toolName} already failed in ${terminalCount} separate steps this run with a NON-RETRYABLE error — it cannot succeed in this run's configuration/state, so this call was NOT executed. Do NOT call ${toolName} again this run, with any arguments. Continue with a different approach, and report the earlier error's guidance as a blocker in your final message if the task cannot proceed without it.`,
    }
  }
  try {
    // Derive the worker-pool scheduling class from the ALS run frame: a
    // background run (sub-agent, routine tick, job-driven re-invocation — see
    // RunContext.background) tags every tool it dispatches "background" so it
    // cannot starve foreground tool calls. Live user chat has no/false flag ⇒
    // interactive. Read at call time inside the AI SDK execute closure, which
    // already runs inside runContextStore.run(runFrame, …) for runs with a frame.
    const priority = runContextStore.getStore()?.background ? "background" : "interactive"
    const result = await executeTool({
      toolName,
      orgId,
      actor,
      params: args,
      threadId,
      // Explicit attribution at the agent seam (Phase 12). "in-app-agent"
      // leaves audit actorType as "user" — same as before the discriminator
      // existed; the marker just makes the intent visible to future readers.
      origin: "in-app-agent",
      stepBundleId,
      priority,
      ...(signal ? { signal } : {}),
    })
    if (result.blocked) {
      // LOAD-BEARING gated-status signal (the single source of truth — agents/apps must NOT
      // describe gating in their prompts; this return string is authoritative). Whether a tool is
      // gated is CONFIG-DEPENDENT (org policy / thresholds), so the agent only learns the outcome
      // HERE. The message tells the agent, unambiguously: the call was accepted+valid, but the action
      // did NOT execute and will run only on human approval — so it must not claim success, must not
      // retry, and may either pause-and-ask or chain a dependent call via the approvalRequestId/@ref.
      const reason = result.blocked.reason
      const baseMessage =
        reason === "gated"
          ? "✅ Your tool call was ACCEPTED and is well-formed, BUT this action is GATED (it requires a human's approval before it runs), so IT HAS NOT EXECUTED. Nothing was created, placed, sent, issued, or changed; the entity does NOT exist yet. It is recorded as a PENDING approval request (approvalRequestId) and will run ONLY if a human approves it. So: (1) tell the user it is PENDING THEIR APPROVAL, referring to it by `approvalHandle` (the request-N label shown on the approval card; keep the uuid for tool calls), do NOT say it was done/created/placed/sent/issued/initiated/submitted/completed, and do NOT contradict yourself; (2) do NOT call this tool again for the same action, that only creates duplicate pending requests; (3) you may now either pause and ask the user to approve, OR, if a later step depends on this action's result, chain that next call now with the @ref token from `outputs` (when this result has `outputs`; see the steps below), you do NOT need to wait for the approval to resolve. To fix a mistake in THIS pending request: if only its CONTENT is wrong, edit it with kernel__approval_update_payload; if the request should not exist at all, withdraw it with kernel__approval_withdraw and then create the corrected request; never retry the original call to try to fix it. If `summary` carries an IRREVERSIBLE or destructive warning (a merge, a delete, a permanent removal), relay it to the user with what would be lost: they are the approver."
          : reason === "taint_escalation"
            ? "✅ Your tool call was ACCEPTED, BUT it is GATED pending human approval because the conversation contains untrusted content, so IT HAS NOT EXECUTED. Nothing was changed; an approval request (approvalRequestId, shown to humans as `approvalHandle`) was recorded. Tell the user it is pending approval, citing `approvalHandle`, do NOT claim it happened, and do NOT retry it. To fix a mistake in THIS pending request: if only its CONTENT is wrong, edit it with kernel__approval_update_payload; if the request should not exist at all, withdraw it with kernel__approval_withdraw and then create the corrected request."
            : "✅ Your tool call was ACCEPTED, BUT it is GATED and HAS NOT EXECUTED; it is recorded as a PENDING approval request (approvalRequestId, shown to humans as `approvalHandle`). Tell the user it is pending approval, citing `approvalHandle`, do NOT claim it happened, and do NOT retry the same action. To fix a mistake in THIS pending request: if only its CONTENT is wrong, edit it with kernel__approval_update_payload; if the request should not exist at all, withdraw it with kernel__approval_withdraw and then create the corrected request."
      const agentNotes = result.blocked.agentNotes
      // A routine run waits for the decision (routine-run-resume.ts): its turn
      // stops after this step and the run resumes with the call's result.
      const routinePause = runContextStore.getStore()?.routineId
        ? ` ${ROUTINE_RUN_PAUSE_CLAUSE}`
        : ""
      // The `request-N` label the approval card and feed print. Handed to the
      // agent alongside the uuid so its reply cites a reference the reviewer
      // can actually see and search (the uuid is hover-only in the UI).
      const approvalRef = result.blocked.approvalRequestId
        ? await resolveApprovalRef(orgId, result.blocked.approvalRequestId)
        : null
      // WHO has to act, appended to every gated variant. Without it the agent
      // reports "pending" and stops, the approver is never told to decide, and
      // the user reads the resulting silence as a broken platform (the 2026-09-11
      // Elevator Sound session). `requesterCanApprove` comes from executeTool so
      // this seam and the MCP one can never disagree about who is being asked.
      const actionRequired = approvalActionRequiredClause(
        result.blocked.requesterCanApprove,
        turnHoldsScope(actor, "kernel:approvals:read"),
        approvalRef?.deciders ?? [],
      )
      const recipe = sequencingRecipe(result.blocked.outputs)
      const message = `${baseMessage} ${actionRequired}${gatedNotesRelay(agentNotes)}${routinePause}${recipe ? ` ${recipe}` : ""}`
      return {
        blocked: true,
        status: "pending_approval",
        reason,
        approvalRequestId: result.blocked.approvalRequestId,
        approvalHandle: approvalRef?.handle ?? null,
        // MCP parity (tool-call.ts): the same decision-audience bit the message
        // is built from, exposed as a field so a caller can branch on it too.
        selfApproveEligible: result.blocked.requesterCanApprove,
        summary: result.blocked.summary,
        message,
        ...(result.blocked.outputs ? { outputs: result.blocked.outputs } : {}),
        ...(result.blocked.hint ? { hint: result.blocked.hint } : {}),
        ...(result.blocked.sequenced ? { sequenced: true } : {}),
        ...(agentNotes ?? {}),
      }
    }
    // Cap what reaches the model (and what invokeAgentForThread persists into
    // toolCalls metadata): an unbounded result — a 738k-char tickets:get was
    // observed in prod — burns the provider's per-minute token quota on this
    // step AND on every future replay of this thread. Structure-preserving:
    // long strings are clipped, the JSON shape stays navigable.
    // A demo visitor's turn takes the visitor limits (result-truncation.ts).
    return truncateToolResultForModel(withHandlerApprovalGuidance(result.data), {
      visitor: currentRunContext()?.visitorTurn === true,
    })
  } catch (err) {
    if (wasRefusedBeforeRun(err, toolName)) onRefusedBeforeRun?.()
    // Tool scope denials surface as a thrown plain Error with status:403 +
    // code:"forbidden" + message:"missing scope: <scope>" (executeTool wraps the
    // `{ error: { code:"forbidden", message:"missing scope: ..." } }` core result).
    // Turn that into an actionable, request-aware message so the agent doesn't
    // just see "Tool execution failed" and silently give up.
    const scopeMatch = err instanceof Error ? /missing scope: (.+)/.exec(err.message) : null
    if (scopeMatch) {
      const scope = scopeMatch[1].trim()
      // A scope denial is a caller/agent error (the agent is told to use
      // request_scope), not a server fault — warn, don't page the watchdog.
      log.warn(
        { err, toolName, status: 403, code: "forbidden", scope },
        "Agent tool denied — missing scope",
      )
      return {
        error: `${repeatedFailurePrefix(toolName, args, stepKey)}Denied: this action needs the "${scope}" scope, which this agent does not have. Use the kernel__request_scope tool to ask an admin to grant it.`,
      }
    }
    // Expected caller-context errors (e.g. spawn_agent's `invalid_context` when
    // ctx.agentExecutionThreadId is missing) are re-thrown by `executeTool()`
    // with `.code` preserved (see execute-tool.ts's `expectedCallerErrorCodes`
    // branch, which already warn-logged once). Warn here too, not the generic
    // error-level path below — a caller-context mistake should not page.
    const errWithCode = err as { code?: unknown }
    if (errWithCode?.code === "invalid_context") {
      log.warn({ err, toolName }, "Agent tool call rejected — invalid caller context")
      return {
        error: `${repeatedFailurePrefix(toolName, args, stepKey)}${err instanceof Error ? err.message : "Invalid caller context for this tool"}`,
      }
    }
    // ── Error reporting & field observability (docs/conventions.md, BINDING) ──────────
    // NEVER a bare, detail-less "Tool execution failed". The agent (and, under chaos, the
    // Opus judge) and the structured log MUST get the REAL signal — tool · status · code ·
    // message · upstream body — so a field failure is actionable for the agent AND becomes a
    // real bug report instead of a swallow. (The external client still gets the safe message
    // via app.onError; this detail is for the trusted agent + the internal log only.)
    const e = err as {
      status?: unknown
      code?: unknown
      body?: unknown
      responseBody?: unknown
      data?: unknown
    }
    const status =
      typeof e?.status === "number"
        ? e.status
        : err instanceof HTTPException
          ? err.status
          : undefined
    const code = typeof e?.code === "string" ? e.code : undefined
    const rawBody = e?.body ?? e?.responseBody ?? e?.data
    let bodyStr = ""
    if (rawBody != null) {
      if (typeof rawBody === "string") bodyStr = rawBody
      else {
        try {
          bodyStr = JSON.stringify(rawBody)
        } catch {
          bodyStr = String(rawBody)
        }
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    // Severity follows the failure's class (mirrors execute-tool.ts "Tool handler
    // threw"): a deliberate typed 4xx is an agent-correctable rejection the
    // agent receives in `detail` below — logging it at error level makes the
    // prod watchdog raise a new-signature CRITICAL for routine agent mistakes.
    // A 500, 502, 504 and a statusless throw stay at error so real faults page.
    // An expected outcome (4xx, 501, 503, a cancelled caller, a guard that held
    // the call) logs at warn with its `reason` (lib/failure-severity.ts).
    logFailure(
      log,
      { status, code, err, guardHeld: isPlatformTaintRefusal(err) },
      { err, toolName, status, code, body: rawBody, message },
      "Agent tool execution error",
    )
    const detail =
      `Tool ${toolName} failed` +
      (status != null ? ` (HTTP ${status}${code ? ` ${code}` : ""})` : code ? ` (${code})` : "") +
      (message ? `: ${message}` : "") +
      (bodyStr ? ` — ${bodyStr.slice(0, 600)}` : "")
    // Terminal (non-retryable) failures: count per toolName so the pre-call
    // circuit breaker above can open, and tell the model explicitly that
    // repeating the call is pointless — the cause is config/state, not args.
    const retryableFlag = (err as { details?: { retryable?: boolean } })?.details?.retryable
    const stale = code !== undefined && STALE_STATE_CODES.has(code)
    let terminalSuffix = stale ? STALE_STATE_NEXT : ""
    if (retryableFlag === false && !stale) {
      const frame = runContextStore.getStore()
      if (frame) {
        frame.toolTerminalFailures ??= new Map()
        recordFailureStep(frame.toolTerminalFailures, toolName, stepKey)
      }
      terminalSuffix =
        " ⛔ This error is NOT retryable: repeating this call will fail identically. Only call this tool again if the error above tells you exactly how to change the call; otherwise use a different approach or report this blocker in your final message."
    }
    return { error: `${repeatedFailurePrefix(toolName, args, stepKey)}${detail}${terminalSuffix}` }
  }
}

/** Set of tool names the model has discovered via tool_search in this conversation */
export type DiscoveredTools = Set<string>

/**
 * Effective deferral of a tool (the Claude Code split): for the IN-PROCESS
 * agent, APP tools are deferred by default — the model sees only their names
 * (system-prompt catalog + tool_search) until it discovers them, so the full
 * schema catalog is never serialized into every provider request. KERNEL tools
 * are the harness and stay hot. `deferLoading` remains the per-tool override in
 * both directions: `false` keeps a hot-path app tool always loaded, `true`
 * defers a rarely-used kernel tool.
 *
 * The GATEWAY audience defers NOTHING: `tools/list` is the complete callable
 * catalog on the very first list, and `deferLoading` is ignored. External MCP
 * clients manage their own context budget (Claude Code, for one, defers MCP
 * tools client-side), so trimming their list buys us nothing — and it used to
 * cost correctness. Tools reached `tools/list` only after `liaison_tool_search`
 * added them mid-connection, announced via `notifications/tools_list_changed`;
 * a client that snapshots its tool table at `initialize` (Claude Code does)
 * never sees that notification, so every `deferLoading: true` tool was
 * PERMANENTLY uncallable there — the whole kernel admin surface
 * (grant_user_scope, describe_user_access, assign_role, edit_role, invite_user)
 * silently among them, with the server cheerfully replying "now in tools/list,
 * call it by its exact name" to a client for which it would never be. Discovery
 * that a client may legitimately ignore cannot be the only door to a capability.
 * `gatewayHidden` (per-connection admin toggle) and
 * `requiresAgentExecutionThread` (structurally in-process) remain the real
 * gateway exclusions, and scopes remain the security boundary; `deferLoading`
 * was only ever a context-budget device for the in-process agent.
 */
export function isDeferredTool(
  appName: string,
  toolDef: { deferLoading?: boolean },
  audience: "agent" | "gateway" = "agent",
): boolean {
  if (audience === "gateway") return false
  return toolDef.deferLoading ?? appName !== "kernel"
}

/**
 * Sentinel value for `discoveredTools` meaning "expose all deferred tools regardless
 * of discovery state". Used by sub-agents and non-chat-agent callers that are given
 * an explicit allowlist and must not go through the tool_search discovery flow.
 */
export const ALL_DEFERRED_TOOLS_UNLOCKED: DiscoveredTools = new Proxy(new Set<string>(), {
  get(target, prop) {
    if (prop === "has") return () => true
    return Reflect.get(target, prop)
  },
})

export function buildToolSet(
  orgId: string,
  actor: ActorContext,
  threadId?: string,
  discoveredTools?: DiscoveredTools,
  /**
   * Who's consuming this tool set?
   * - `"agent"` (default) — the in-process LLM agent. All visible tools are returned.
   * - `"gateway"` — the outbound MCP server (`listMcpTools`). Tools flagged
   *   `gatewayHidden` (set by inbound projection when its connection has
   *   `expose_via_gateway=false`) are EXCLUDED so external MCP clients never see them.
   */
  audience: "agent" | "gateway" = "agent",
  /**
   * Optional ALS frame to enter inside every tool's `execute`. `runAgentChat`
   * and the subrun worker pass the frame for the run that owns the loop so
   * any tool that consults `currentRunContext()` (notably `spawn_agent` —
   * which needs the parent's `runId` to chain `parent_run_id` on the new
   * `agent_runs` row) sees the right ancestor. Without this, AI SDK invokes
   * `execute` from inside its own stream queue — outside any
   * `runContextStore.run(...)` block opened in the caller — so the ALS frame
   * never reaches the tool.
   */
  runFrame?: RunContext,
  /**
   * Mutable step context shared with the agent stream loop. The loop lazy-inits
   * `stepBundleId` on the first `tool-call` chunk of an agent step (under
   * `PARALLEL_APPROVAL_BUNDLING`), resets to null on `finish-step`. Each tool's
   * `execute` closure reads it at call time, so every gated approval created
   * in one step sees the same bundle id. Optional — omitted callers (sub-runs,
   * MCP gateway, tests) get null bundle ids.
   */
  stepCtx?: StepContext,
): Record<string, any> {
  const tools: Record<string, any> = {}
  // A turn's effective scope narrows the catalog but never widens it past the
  // actor; an empty one admits nothing. Absent, the actor's own scopes apply.
  const actorScopes = turnToolScopes(actor.scopes ?? [], runFrame)

  // Capability gate for `kernel:spawn_agent`. `agent.spawn` is now a
  // kernel-universal capability (see `KERNEL_CAPABILITIES` in app-registries),
  // so `orgHasCapability` returns true for every org with no app install
  // required — this gate always passes and `spawn_agent` always registers. The
  // gate is retained so the suppression mechanism stays in place should a
  // capability ever become app-gated again.
  const hasSpawnCapableApp = orgHasCapability(orgId, "agent.spawn")

  for (const [key, toolDef] of toolRegistry.entriesOf(orgId)) {
    // Filter by org
    if (key[0] !== orgId) continue

    // An app turned Off (or removed) for the workspace (S19) contributes no
    // tool to any audience. The caller primed the per-org state (primeOrgApps)
    // before this walk; dispatch re-checks it (executeToolCore).
    if (isAppOffForOrg(orgId, key[1])) continue
    // A feature switched off takes its tools from every set the same way, here
    // as in the catalog: a tool held here and missing from the catalog would
    // count as not deferred and reach the provider on every step.
    if (isFeatureOffForTool(orgId, toolDef)) continue

    // `kernel:spawn_agent` gate — always passes now that `agent.spawn` is
    // kernel-universal (see above).
    if (key[1] === "kernel" && key[2] === "spawn_agent" && !hasSpawnCapableApp) continue

    // Routine-only tools (web_watch / watch_state) — CALLABLE only when the run
    // frame is a routine tick (the routine worker stamps `routineId` on the frame).
    // Invisible to interactive chat + sub-runs at CALL time, where the tool would
    // have no per-routine state. (They remain DISCOVERABLE via tool_search /
    // listDeferredTools so the routine-AUTHORING agent learns the stateful-diff path
    // exists and references it in the routine PROMPT.)
    if (toolDef.routineOnly && !runFrame?.routineId) {
      continue
    }

    // Filter by scope. Fail closed: a tool that declares no required scope is
    // never admitted, whatever the actor holds. A tool needs ALL its declared
    // scopes, since each one is a distinct capability it uses.
    if (!checkToolScopes(toolDef, actorScopes).authorized) continue

    // A READ-ONLY run (the Share anyway rerun, spec-security.md D4) admits no
    // write tool: re-answering a withheld turn must not send its mail or open
    // its ticket a second time. An unmarked tool counts as a write and is
    // excluded too (fail closed) -- see modules/agent/runtime/read-only-run.ts.
    if (runFrame?.readOnlyTools && !isReadOnlyTool(toolDef)) continue

    // Hide tools opted out of agent discovery
    if (toolDef.agentVisible === false) continue

    // An `agentBoundOnly` tool needs an agent to be acting AS. The in-app turn
    // usually has one, but `resolveTurnScope` returns null when no live agent
    // is resolvable for the thread, and that turn is nobody's agent: it gets
    // the same catalog a plain MCP token gets (tool-projection.ts runs the
    // same predicate on `ctx.agentId`).
    // The gateway audience is EXCLUDED here on purpose: an MCP listing carries
    // no run frame at all, and `listMcpTools` runs the same predicate on the
    // connection's own `ctx.agentId`. Judging a frameless listing by the
    // missing frame would strip the tool from every MCP client, agent bound
    // ones included.
    if (audience === "agent" && toolDef.agentBoundOnly && !runFrame?.agentId) continue
    // A tool that reads the person's own computer, for a person with none.
    if (audience === "agent" && toolDef.needsOwnComputer && runFrame?.noOwnComputer) continue

    // Outbound MCP server: gateway-hidden tools are invisible
    if (audience === "gateway" && toolDef.gatewayHidden) continue

    // Structurally agent-execution-thread-bound tools (e.g. spawn_agent) can
    // never succeed from an external MCP client — there is no in-process
    // agent run frame to supply ctx.agentExecutionThreadId. Exclude them from
    // the gateway projection entirely rather than let a caller-context mistake
    // reach the handler's hard guard. The in-process agent audience is
    // unaffected.
    if (audience === "gateway" && toolDef.requiresAgentExecutionThread) continue

    // Unreachable MCP tools (down / failed / needs_reauth / disabled) are
    // skipped for both audiences so the agent doesn't waste a turn on a tool
    // it can't actually call. The reverse-map from `mcp:<slug>:<tool>` to
    // `connectionId` lives in `slugIndex`. Also: personal-connection tools
    // are hidden from any actor who isn't the owner (spec success criterion #9).
    if (key[1] === "mcp") {
      const sepIdx = key[2].indexOf(":")
      const slug = sepIdx > 0 ? key[2].slice(0, sepIdx) : key[2]
      const connectionId = slugIndex.get(orgId, slug)
      if (connectionId && getHealthGate().isUnreachable(connectionId)) continue
      const actorUserId = actor.actorType === "user" ? actor.userId : null
      if (toolDef.ownerUserId && toolDef.ownerUserId !== actorUserId) continue
    }

    const fullName = `${key[1]}:${key[2]}`
    // AI SDK passes tool names directly to providers — both OpenAI and Anthropic require
    // ^[a-zA-Z0-9_-]+$. Use double-underscore as the app/tool separator and sanitize any
    // remaining disallowed chars (manifest tools may use dots like `categories.list`).
    const sanitized = key[2].replace(/[^a-zA-Z0-9_-]/g, "_")
    const sdkName = `${key[1]}__${sanitized}`

    // Deferred tools (app tools by default — see isDeferredTool): only include
    // once the model has discovered them via tool_search. undefined means "no
    // tool_search context" (gateway listing, legacy callers) — treat the same as
    // an empty discovered set. Pass ALL_DEFERRED_TOOLS_UNLOCKED to bypass this
    // gate (used by sub-agents with explicit allowlists and the chat agent,
    // which gates per-step via activeTools instead).
    if (
      isDeferredTool(key[1], toolDef, audience) &&
      (!discoveredTools || !discoveredTools.has(sdkName))
    ) {
      continue
    }

    const deferredForAgent = isDeferredTool(key[1], toolDef, audience)
    const paramsForBlindCall = toolDef.params

    tools[sdkName] = tool({
      description: toolDef.description,
      // Normalized on the way to the provider (tuple `items` lists 400 Gemini
      // for the whole turn); the Zod schema and what it accepts are unchanged.
      inputSchema:
        audience === "gateway"
          ? gatewayInputSchemaOf(toolDef.params)
          : providerInputSchemaOf(toolDef.params),
      // A failed call goes to the model as an error output (`status: "failed"`), never as a
      // plain JSON result it could read as success or as pending (tool-failure-output.ts).
      // Everything else gets the SDK's own default: text for a string, JSON otherwise.
      toModelOutput: ({ output }: { output: unknown }) =>
        toolFailureModelOutput(output) ??
        (typeof output === "string"
          ? { type: "text" as const, value: output }
          : { type: "json" as const, value: toJsonValue(output) }),
      // The AI SDK passes an options object carrying `abortSignal` as the second
      // argument. It used to be ignored; the mailbox decrypt wait below needs it,
      // because a turn that dies mid-wait must settle its promise and evict its
      // registry entry rather than leaking both (amendment A22).
      execute: async (
        modelArgs: unknown,
        opts?: { abortSignal?: AbortSignal; toolCallId?: string; messages?: readonly unknown[] },
      ) => {
        // What the model sent, less any host-only parameter: those come from the mailbox
        // retry below only (host-only-params.ts), never from the model.
        const args = stripHostOnlyParams(modelArgs)
        // Blind-call gate: the chat agent's full set stays executable while
        // `activeTools` gates what the provider SEES — and Gemini happily emits
        // calls to tools it was never given a declaration for (it knows the
        // names from the system-prompt catalog). Executing such a call is a
        // schema-less guess (observed in prod: tickets__reply called 14× with
        // only {ticketId}, each 400ing, because the model had no schema to fix
        // its args with). Instead: treat the call AS the discovery — unlock the
        // tool (schema + full app guide reach the provider next step) and
        // return the parameter list so the retry is correct. Only applies to
        // runs that use the discovery flow (frame carries `discoveredTools`);
        // sub-agent allowlists and the gateway are untouched.
        // VALIDATE-THEN-EXECUTE (not reject-then-retry): the old gate returned
        // "NOT EXECUTED … retry next step", charging one full-context step per
        // first-touch of every tool — measured at 28% of a runaway day's calls,
        // and the retry lands exactly when context is fattest. executeTool
        // zod-validates params BEFORE any handler/gating runs, so letting the
        // blind call through is safe: valid args execute now (a step saved);
        // invalid args come back as a precise invalid_params naming the missing
        // fields, to which we append the full parameter list — the same
        // schema-teaching value the rejection had, at the same single-step
        // cost. The historical schema-less retry loop (a model re-issuing one
        // guessed call: {ticketId} 14×) is covered by the parameter hint below
        // plus the repeated-failure escalator and the terminal-failure breaker.
        // An answer-only step runs nothing (StepContext above).
        const answerOnly = stepCtx?.answerOnly
        if (answerOnly) {
          log.info(
            { toolName: fullName, threadId: threadId ?? null },
            "Tool call in an answer-only step: not run",
          )
          return answerOnlyRefusal(answerOnly)
        }
        const chainOnly = stepCtx?.chainOnly
        if (chainOnly && !chainStepAdmits(fullName, toolDef, args)) {
          log.info(
            { toolName: fullName, threadId: threadId ?? null },
            "Tool call while a routine run chains on a parked call: not run",
          )
          return answerOnlyRefusal(chainOnly)
        }
        const frameDiscovered = runFrame?.discoveredTools
        const blindDiscovery =
          deferredForAgent && frameDiscovered != null && !frameDiscovered.has(sdkName)
        if (blindDiscovery) {
          frameDiscovered.add(sdkName)
          log.warn(
            { toolName: fullName, sdkName },
            "Blind call to undiscovered deferred tool — unlocked, validating and executing",
          )
        }
        // The per turn memory call cap. Counted before the call runs and before
        // any other gate, so a refused or failing retrieval still spends its
        // slot: the budget exists to bound how much of a turn goes to looking
        // things up, and a call that came back empty cost the same context.
        if (runFrame && key[1] === "kernel" && isRetrievalTool(key[2])) {
          const used = memoryCallsByFrame.get(runFrame) ?? 0
          if (used >= MAX_MEMORY_CALLS_PER_TURN) {
            log.warn(
              {
                threadId: threadId ?? null,
                agentId: runFrame.agentId ?? null,
                toolName: fullName,
                memoryCalls: used,
                cap: MAX_MEMORY_CALLS_PER_TURN,
              },
              "memory_call_cap",
            )
            return memoryCallCapRefusal()
          }
          memoryCallsByFrame.set(runFrame, used + 1)
        }
        const sid = stepCtx?.stepBundleId ?? null
        // Read once per call: a mailbox re-run of this call is the same step.
        const stepKey = toolStepKey(opts)
        // Scope taint reads what EARLIER calls brought into the turn, so the
        // snapshot is taken before this call records its own scopes; otherwise
        // every scoped write would taint itself. A frame without an accumulator
        // (the MCP gateway) evaluates no taint.
        const accumulator = runFrame?.turnScopeAccumulator
        const touchedBefore = accumulator?.snapshot()
        let refusedBeforeRun = false
        const invokeWith = async (callArgs: unknown) => {
          const run = () =>
            executeWrapper(
              fullName,
              callArgs,
              actor,
              orgId,
              threadId,
              sid,
              runFrame?.turnRecord?.toolSignal ?? opts?.abortSignal,
              stepKey,
              () => {
                refusedBeforeRun = true
              },
            )
          const framed = () => (runFrame ? runContextStore.run(runFrame, run) : run())
          // Whether this call marked the turn as having read outside text, for its stored record.
          const taintWatch = threadId ? watchTaintMarks(threadId) : null
          try {
            // A sub-run spawned by this call inherits the same pre-call snapshot.
            return await (touchedBefore
              ? runWithToolCallScopesBefore(touchedBefore, framed)
              : framed())
          } finally {
            if (taintWatch?.marked && opts?.toolCallId) {
              runFrame?.taintedToolCallIds?.add(opts.toolCallId)
            }
            taintWatch?.stop()
          }
        }
        // A taint-free kernel tool (catalog, capability listing, navigation)
        // reads no org data, so it records nothing; the check below still
        // applies to it. Recorded for a call that throws or is refused too: it
        // may have read something before it failed, so it still counts toward
        // the turn's scope set. The one call that records NOTHING is a gated
        // call parked for approval (see below): it never ran at all.
        // A call that is taint free for its arguments alone (threads_read of this very
        // conversation: its messages are the turn's history, whose stamps the handler records)
        // records nothing either.
        const recordTurnScopes = () => {
          if (toolDef.taintFree === true) return
          if (toolDef.taintFreeWhen?.(args, { executionThreadId: threadId }) === true) return
          accumulator?.record(toolDef)
        }
        // Belt and braces for a write that reached this closure anyway: a blind
        // call to an undiscovered tool, or a catalog built before the frame was
        // marked. Refused the way a scope-taint refusal is refused -- returned
        // as the tool's RESULT, not thrown -- so the model sees it, can say so,
        // and the rerun still finishes with the answer it can produce.
        if (runFrame?.readOnlyTools) {
          const blocked = checkReadOnlyRun(toolDef)
          if (blocked) {
            recordTurnScopes()
            log.warn(
              { toolName: fullName, writeTargetTable: blocked.writeTargetTable },
              "Tool call refused: this run may not write",
            )
            return blocked
          }
        }
        if (touchedBefore) {
          // A46: judged against the rows this call targets and the rows the turn's
          // reads came from, so a write back to the same resource passes and every
          // other row, table or undeclared target is refused exactly as before.
          const refused = checkToolScopeTaint(touchedBefore, toolDef, {
            args,
            originRows: accumulator?.originRows(),
            // Every write is judged at the dispatch, which parks what taint would refuse.
            deferGatedToDispatch: true,
          })
          if (refused) {
            recordTurnScopes()
            log.warn(
              { toolName: fullName, writeTargetTable: refused.writeTargetTable },
              "Tool call refused by scope taint",
            )
            // Recorded on the frame so the turn's own withheld card knows a
            // rerun would be refused the same way, which is the whole reason
            // the card hides "Share anyway" for a tainted item.
            if (runFrame) runFrame.scopeTaintRefused = true
            return refused
          }
        }
        let result: unknown
        // A WRITE OF A DURABLE TURN RUNS AT MOST ONCE (S10, tool-effect-key.ts).
        // A turn resumed on another process re-issues its cut step, and the
        // model asks for the same call again: keyed on (tool, args, occurrence),
        // the re-call meets the first call's ledger row and gets its stored
        // result, or "outcome unknown" when that call's process died mid-way.
        const turnRecord = runFrame?.turnRecord
        const effectSlot =
          turnRecord && !isReadOnlyTool(toolDef)
            ? turnRecord.effectKeys.reserve(fullName, args)
            : null
        try {
          if (turnRecord && effectSlot) {
            // The ledger keeps what the reply would keep: a mail tool's result
            // from an encrypted mailbox is stored redacted (Invariant K).
            const outcome = await effectOnce(orgId, effectSlot.key, () => invokeWith(args), {
              store: (raw) => redactMailToolResult(orgId, sdkName, raw),
              inFlightWaitMs: effectInFlightWaitMs,
            }).catch((err: unknown) => {
              if (!(err instanceof EffectInFlight)) throw err
              return { status: "in_flight" as const }
            })
            if (outcome.status === "in_flight") {
              // Another process still runs this exact call (a handoff let it
              // finish): sticky, so an identical re-call meets the same key
              // and the same answer instead of running as the next one (H2).
              effectSlot.release()
              recordTurnScopes()
              log.warn(
                { toolName: fullName, turnId: turnRecord.turnId, key: effectSlot.key },
                "tool_effect_in_flight",
              )
              return effectInFlightResult()
            }
            if (outcome.status === "unknown") {
              // Sticky for this turn: an identical re-call hits the same key again.
              effectSlot.release()
              recordTurnScopes()
              log.warn(
                { toolName: fullName, turnId: turnRecord.turnId, key: effectSlot.key },
                "tool_outcome_unknown",
              )
              return outcomeUnknownResult()
            }
            if (outcome.status === "replayed") {
              log.info(
                { toolName: fullName, turnId: turnRecord.turnId, key: effectSlot.key },
                "tool_effect_replayed",
              )
            }
            result = outcome.result
          } else {
            result = await invokeWith(args)
          }
        } catch (err) {
          recordTurnScopes()
          throw err
        }
        // A GATED CALL PARKED FOR APPROVAL BRINGS NOTHING INTO THE TURN. Its
        // handler never ran: the result is an approval handle and a summary
        // built from the agent's own arguments, no org data at all. Recording
        // its scope would taint the turn on a call that read nothing, and the
        // next gated call of the same turn would then be refused as a write
        // from a tainted turn. That is exactly the compound bundle the platform
        // is built to stage ("reply plus proforma plus label" under one human
        // decision), so the staging call records no taint. The write itself is
        // still judged: the approval row carries `proposing_turn_scopes` and the
        // approved re-entry writes with them.
        if (!isParkedForApproval(result) && !refusedBeforeRun) recordTurnScopes()
        // The two-phase mailbox read protocol (blueprint Task 9.2). This is the
        // ONLY place in the chain that can suspend a turn: the sandbox cannot
        // (5 s budget, a timeout kills the worker) and the stream loop cannot
        // (by the time a tool-result chunk exists, so does the result). A result
        // carrying no marker passes through this untouched and unawaited.
        if (readMailboxMarker(result)) {
          const fulfilment = await fulfilMailboxMarker({
            result,
            orgId,
            // A non-user actor has no mailbox to unlock, and the empty string
            // resolves to no unlock assertion, which is the locked path.
            userId: actor.actorType === "user" ? (actor.userId ?? "") : "",
            // No thread means no stream to ask over (the MCP gateway, a blind
            // call), which the broker treats as locked.
            threadId: threadId ?? "",
            frame: runFrame,
            // For the audit row of a server-side (managed mailbox) read.
            toolName: fullName,
            ...(opts?.abortSignal ? { abortSignal: opts.abortSignal } : {}),
          })
          if (fulfilment.retryArgs) {
            // Quote and attachment work cannot be finished with a context block:
            // the SEND has to carry the client's bytes. So the tool runs a second
            // time with the client-supplied material merged into its arguments.
            const retryArgs = {
              ...(args && typeof args === "object" ? (args as Record<string, unknown>) : {}),
              ...fulfilment.retryArgs,
            }
            // The send itself: once per turn, as the first invocation (only the
            // key is derived from the material, never stored with it).
            if (turnRecord && effectSlot) {
              const retried = await effectOnce(
                orgId,
                `${effectSlot.key}:mailbox`,
                () => invokeWith(retryArgs),
                {
                  store: (raw) => redactMailToolResult(orgId, sdkName, raw),
                  inFlightWaitMs: effectInFlightWaitMs,
                },
              ).catch((err: unknown) => {
                if (!(err instanceof EffectInFlight)) throw err
                return { status: "in_flight" as const }
              })
              result =
                retried.status === "unknown"
                  ? outcomeUnknownResult()
                  : retried.status === "in_flight"
                    ? effectInFlightResult()
                    : retried.result
            } else {
              result = await invokeWith(retryArgs)
            }
          } else {
            result = fulfilment.result
          }
        }
        if (
          blindDiscovery &&
          result &&
          typeof result === "object" &&
          typeof (result as { error?: unknown }).error === "string"
        ) {
          ;(result as { error: string }).error +=
            ` NOTE: this call also LOADED ${sdkName} — its full schema is available to you now.` +
            ` Parameters: ${describeToolParams(paramsForBlindCall)}.`
        }
        // A repeat fetch of a page this run already holds whole is a reference to it.
        if (sdkName === "kernel__web_fetch") {
          return repeatFetchResult(runFrame, args, result, opts?.toolCallId)
        }
        return result
      },
    })
  }

  // Deterministic ordering: tool declarations serialize at the FRONT of every
  // provider request, and prompt caches (Gemini implicit, OpenAI automatic,
  // Anthropic) prefix-match byte-for-byte — registry iteration order can vary
  // across process restarts, and a reordered tool array is a full cache miss
  // from position 0. Sort by SDK name so the serialized catalog is stable.
  const sorted: Record<string, any> = {}
  for (const name of Object.keys(tools).sort()) sorted[name] = tools[name]
  rememberHeldToolSet(sorted, { orgId, scopes: actorScopes })
  return sorted
}

/**
 * Reorder a turn's tool set IN PLACE: the tools the provider sees from the
 * turn's first step (`startingSurface`) first, then every other tool. A tool a
 * later step loads then joins the provider's list at its end (`moveToolsToEnd`),
 * so the earlier part of the request stays the prefix the provider has cached
 * (agent-service.ts, A TOOL LOADED MID-TURN JOINS AT THE END). In place because
 * the turn's other holders (the late-tool admission, the step hook) share this
 * object.
 *
 * THE THREAD'S ORDER, NOT THE ALPHABET. `threadOrder` is the order the
 * thread's previous turn sent its tools in (its reply's `toolOrder`).
 * The starting surface keeps that order, and a tool new to the thread goes
 * after it: sorted by name, a tool the last turn loaded mid-turn (sent at the
 * END of that turn's list) moved into the middle of the next turn's list, and
 * the next turn's first step re-read its whole prompt (live demo: 3k of 55k
 * tokens cached on most turn starts). The order is: the starting tools the
 * last turn sent, in its order; the other starting tools by name; then every
 * tool not in the starting surface, by name.
 */
export function orderStartingToolsFirst(
  tools: Record<string, unknown>,
  startingSurface: ReadonlySet<string>,
  threadOrder: readonly string[] = [],
): void {
  const position = new Map(threadOrder.map((name, i) => [name, i]))
  const names = Object.keys(tools).sort()
  const starting = names.filter((n) => startingSurface.has(n))
  const ordered = [
    ...starting
      .filter((n) => position.has(n))
      .sort((a, b) => (position.get(a) as number) - (position.get(b) as number)),
    ...starting.filter((n) => !position.has(n)),
    ...names.filter((n) => !startingSurface.has(n)),
  ]
  moveToolsToEnd(tools, ordered)
}

/** Move `names` (those present) to the end of `tools`, in that order, IN PLACE. */
export function moveToolsToEnd(tools: Record<string, unknown>, names: readonly string[]): void {
  for (const name of names) {
    if (!(name in tools)) continue
    const tool = tools[name]
    delete tools[name]
    tools[name] = tool
  }
}

/**
 * Build a tool set scoped to a sub-agent run: filters `buildToolSet`'s output
 * through the role's effectiveScopes + allowlist + denylist. The toolRegistry's
 * own scope predicate already runs against `actor.scopes` — we layer the
 * sub-run effective scope intersection on top so role narrowing applies.
 *
 * `allowlist` is a set of full `app:tool` names (NOT the SDK-sanitized form).
 * `denylist` likewise. Either may be `null` for "no restriction at this layer".
 */
export function buildScopedToolSet(
  orgId: string,
  actor: ActorContext,
  threadId: string,
  opts: {
    effectiveScopes: string[]
    allowlist: string[] | null
    denylist: string[] | null
    skills?: string[]
  },
  /**
   * Same ALS frame as `buildToolSet`'s `runFrame`. Sub-runs use this so
   * `spawn_agent` invoked by the child sees the child's run context and
   * chains `parent_run_id` / `nesting_depth` correctly. Without this, the
   * AI SDK invokes `execute` outside the worker's `runContextStore.run(...)`
   * block, `currentRunContext()` returns undefined, and `nesting_depth`
   * silently floors to 1 for every descendant.
   */
  runFrame?: RunContext,
): Record<string, any> {
  const scopedActor: ActorContext = { ...actor, scopes: opts.effectiveScopes }
  // Sub-agents receive an explicit allowlist — expose all deferred tools so the
  // allowlist filter (below) can select from the full set without needing tool_search.
  const baseTools = buildToolSet(
    orgId,
    scopedActor,
    threadId,
    ALL_DEFERRED_TOOLS_UNLOCKED,
    "agent",
    runFrame,
  )

  if (!opts.allowlist && !opts.denylist) return baseTools

  // SDK keys are `${appName}__${sanitizedToolName}`; the canonical form in
  // allow/denylist is `appName:toolName`. We re-walk the registry to match
  // each tool's canonical name to the SDK key we kept in baseTools.
  const allowSet = opts.allowlist ? new Set(opts.allowlist) : null
  const denySet = opts.denylist ? new Set(opts.denylist) : null

  const out: Record<string, any> = {}
  for (const [key] of toolRegistry.entriesOf(orgId)) {
    if (key[0] !== orgId) continue
    const canonical = canonicalToolName(key[1], key[2])
    const sdkName = sdkToolName(key[1], key[2])
    if (!(sdkName in baseTools)) continue
    if (denySet && denySet.has(canonical)) continue
    if (allowSet && !allowSet.has(canonical)) continue
    out[sdkName] = baseTools[sdkName]
  }
  rememberHeldToolSet(out, { orgId, scopes: opts.effectiveScopes })
  return out
}

/**
 * Inverse of the `buildToolSet` scope filter: enumerate the tools in THIS org
 * that the actor would have access to if only they held more scope — i.e. the
 * tool is gated by a scope the actor lacks, and is not hidden for any *other*
 * reason (agentVisible:false, unreachable/personal MCP). Org-scoped by
 * construction (the registry walk filters `key[0] === orgId`), so cross-org
 * capabilities never leak. Powers the `list_locked_capabilities` kernel tool so
 * a blocked agent can name exactly what it's missing and which scope unlocks it.
 */
export function listLockedCapabilities(
  actorScopes: string[],
  orgId: string,
  actorUserId?: string | null,
): Array<{ name: string; scope: string; description: string; app: string }> {
  const locked: Array<{ name: string; scope: string; description: string; app: string }> = []
  // Mirror buildToolSet's capability gate. `agent.spawn` is now kernel-universal
  // (always present), so this always evaluates true and `kernel:spawn_agent` is
  // never suppressed — the mirror is retained for symmetry with buildToolSet.
  const hasSpawnCapableApp = orgHasCapability(orgId, "agent.spawn")

  for (const [key, toolDef] of toolRegistry.entriesOf(orgId)) {
    if (key[0] !== orgId) continue // org-scoped — never leak other orgs
    // An Off app's tools, and a restricted app's for a person it is
    // restricted away from, are not "lockable": no scope request brings them
    // back (S19, S20, A12).
    if (isAppUnavailableFor(orgId, key[1], actorUserId)) continue
    // No scope brings back a tool whose feature is off either.
    if (isFeatureOffForTool(orgId, toolDef)) continue
    if (key[1] === "kernel" && key[2] === "spawn_agent" && !hasSpawnCapableApp) continue
    // Only tools the actor is missing a scope for. A tool that declares no
    // scope is refused to everyone, so no grant unlocks it: never list it.
    const scopeCheck = checkToolScopes(toolDef, actorScopes)
    if (scopeCheck.required.length === 0 || scopeCheck.authorized) continue
    // Hidden-for-other-reasons tools are not "lockable by scope" — skip them.
    if (toolDef.agentVisible === false) continue
    // Personal/unreachable MCP tools follow the same visibility rules as buildToolSet.
    if (key[1] === "mcp") {
      const sepIdx = key[2].indexOf(":")
      const slug = sepIdx > 0 ? key[2].slice(0, sepIdx) : key[2]
      const connectionId = slugIndex.get(orgId, slug)
      if (connectionId && getHealthGate().isUnreachable(connectionId)) continue
      if (toolDef.ownerUserId && toolDef.ownerUserId !== (actorUserId ?? null)) continue
      // A server the actor may not use is the admin's access choice, not a
      // missing scope to request (see listCatalogTools): never listed as locked.
      continue
    }

    locked.push({
      name: `${key[1]}__${key[2].replace(/[^a-zA-Z0-9_-]/g, "_")}`,
      scope: scopeCheck.missing.join(", "),
      description: toolDef.description,
      app: key[1],
    })
  }

  return locked
}

/**
 * Adds to a run's built tool set the named tools it does not hold yet, taken
 * from a fresh build (`rebuild`), in place: the AI SDK reads the same object
 * at every step, so a tool added here is callable on the next step of the
 * run. A tool registered after the set was built (an MCP server whose tool
 * list arrived with tool_search's own dial) is the case this exists for. A
 * name the fresh build does not hold either (out of scope, unreachable, not
 * the actor's) stays out. Returns the names added and which of `names` the
 * set now holds. Rebuilds only when a name is missing.
 */
export function admitLateTools(
  names: readonly string[],
  tools: Record<string, unknown>,
  rebuild: () => Record<string, unknown>,
): { admitted: string[]; callable: Set<string> } {
  const admitted: string[] = []
  const missing = names.filter((n) => !(n in tools))
  if (missing.length > 0) {
    const fresh = rebuild()
    for (const name of missing) {
      if (!(name in fresh)) continue
      tools[name] = fresh[name]
      admitted.push(name)
    }
  }
  return { admitted, callable: new Set(names.filter((n) => n in tools)) }
}
/** List deferred tools for the tool_search tool and system prompt announcement */
export function listDeferredTools(
  orgId: string,
  actor?: ActorContext,
  audience: "agent" | "gateway" = "agent",
  includeLocked = false,
  // Whether the person has no computer set up for Liaison: tools that read
  // it are then left out. Defaults to the running turn's frame (tool_search);
  // the system prompt, assembled outside it, passes its own read.
  turn: { noOwnComputer?: boolean } = {
    noOwnComputer: runContextStore.getStore()?.noOwnComputer,
  },
): ReturnType<typeof listCatalogTools> {
  return listCatalogTools(orgId, actor, audience, includeLocked, true, turn.noOwnComputer === true)
}

/**
 * Every tool the outbound MCP gateway exposes for this actor — the searchable
 * counterpart to `listMcpTools`, minus the JSON schemas. `liaison_tool_search`
 * ranks THIS, not the deferred subset: the gateway defers nothing (see
 * `isDeferredTool`), so a deferred-only search would score an empty list and
 * answer "no such tool" for tools sitting in the caller's own tools/list.
 */
/**
 * The two names ONE tool answers to. `canonicalToolName` is the form
 * `kernel.agents` documents and the allow/deny lists are curated in
 * (`app:tool`); `sdkToolName` is the key the SDK tool set and the MCP gateway
 * catalog use (`app__tool`, with characters the SDK rejects replaced).
 *
 * Exported because the MCP gateway's own allow/deny filter must derive them
 * the SAME way this file does: a policy matched against one form there and the
 * other form here is a policy that silently does nothing on one of the paths.
 */
export function canonicalToolName(appName: string, toolName: string): string {
  return `${appName}:${toolName}`
}

export function sdkToolName(appName: string, toolName: string): string {
  return `${appName}__${toolName.replace(/[^a-zA-Z0-9_-]/g, "_")}`
}

/**
 * One registry walk, giving every tool of this org as `sdkName -> canonical`.
 * The gateway catalog filter needs the canonical form for each of the names it
 * already holds, and walking the registry per tool would be quadratic.
 */
export function canonicalToolNamesBySdkName(orgId: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const [key] of toolRegistry.entriesOf(orgId)) {
    if (key[0] !== orgId) continue
    map.set(sdkToolName(key[1], key[2]), canonicalToolName(key[1], key[2]))
  }
  return map
}

export function listGatewayTools(
  orgId: string,
  actor?: ActorContext,
  includeLocked = false,
): ReturnType<typeof listCatalogTools> {
  return listCatalogTools(orgId, actor, "gateway", includeLocked, false)
}

function listCatalogTools(
  orgId: string,
  actor?: ActorContext,
  audience: "agent" | "gateway" = "agent",
  // When true, tools the actor LACKS the RBAC scope for are still returned, flagged
  // `locked:true` with the `requiredScope` they need (intra-org only, like
  // list_locked_capabilities). This lets tool_search reveal a capability that EXISTS
  // but is scope-locked — so a weak agent learns it must request the scope instead of
  // silently not seeing the tool and FABRICATING that it acted. Only the org RBAC scope
  // gate is relaxed; agentVisible / gateway-hidden / MCP-unreachable / personal-owner
  // filters still fully apply (a locked tool is never an unreachable or another user's
  // personal tool). [[BL-254]] / DECISIONS l500.
  includeLocked = false,
  // When true, keep only tools gated behind discovery (`listDeferredTools`).
  // When false, return every tool the audience can see (`listGatewayTools`).
  onlyDeferred = true,
  // When true, tools marked `needsOwnComputer` are left out (agent audience).
  noOwnComputer = false,
): Array<{
  sdkName: string
  appName: string
  toolName: string
  description: string
  keywords?: readonly string[]
  aliases?: readonly string[]
  locked?: boolean
  requiredScope?: string
  routineOnly?: boolean
}> {
  const results: Array<{
    sdkName: string
    appName: string
    toolName: string
    description: string
    keywords?: readonly string[]
    aliases?: readonly string[]
    locked?: boolean
    requiredScope?: string
    routineOnly?: boolean
  }> = []
  const actorScopes = actor?.scopes ?? []
  // A hidden tool's name still finds the visible tool it sends an agent to.
  const aliases = hiddenToolAliases(
    [...toolRegistry.entriesOf(orgId)]
      .filter(([key]) => key[0] === orgId)
      .map(([key, def]) => ({
        appName: key[1],
        toolName: key[2],
        agentVisible: def.agentVisible,
        useInstead: def.useInstead,
      })),
  )

  for (const [key, toolDef] of toolRegistry.entriesOf(orgId)) {
    if (key[0] !== orgId) continue
    // An Off app (S19) is in no catalog, deferred, gateway or locked.
    if (isAppOffForOrg(orgId, key[1])) continue
    if (isFeatureOffForTool(orgId, toolDef)) continue
    // Surface deferred (app) tools AND routine-only kernel tools (web_watch /
    // watch_state). The latter are NOT deferLoading — they are core tools merely
    // execution-gated to routine ticks — but they MUST be discoverable so the
    // routine-authoring agent learns the stateful-diff path exists (the
    // ines-weekly-review-watch tool-surface gap: undiscoverable web_watch →
    // the agent improvised a manual knowledge-doc dedup). They are gateway-hidden
    // (a routine-only tool has no meaning over the outbound MCP projection).
    if (onlyDeferred && !isDeferredTool(key[1], toolDef, audience) && !toolDef.routineOnly) continue
    if (toolDef.routineOnly && audience === "gateway") continue
    // A tool that declares no scope is refused to everyone and no grant
    // unlocks it, so it is never listed, locked or not.
    const scopeCheck = checkToolScopes(toolDef, actorScopes)
    if (scopeCheck.required.length === 0) continue
    const locked = !!actor && !scopeCheck.authorized
    if (locked && !includeLocked) continue
    if (toolDef.agentVisible === false) continue
    if (audience === "gateway" && toolDef.gatewayHidden) continue
    if (audience === "gateway" && toolDef.requiresAgentExecutionThread) continue
    if (audience === "agent" && noOwnComputer && toolDef.needsOwnComputer) continue

    // Unreachable MCP tools — hidden from the deferred catalog too. Personal
    // tools also hidden from non-owners (review B6). These are NOT RBAC-scope
    // gates, so they suppress even when includeLocked is set.
    if (key[1] === "mcp") {
      const sepIdx = key[2].indexOf(":")
      const slug = sepIdx > 0 ? key[2].slice(0, sepIdx) : key[2]
      const connectionId = slugIndex.get(orgId, slug)
      if (connectionId && getHealthGate().isUnreachable(connectionId)) continue
      if (actor && toolDef.ownerUserId) {
        const actorUserId = actor.actorType === "user" ? actor.userId : null
        if (toolDef.ownerUserId !== actorUserId) continue
      }
      // Who can use an org server is the admin's choice on the server's page
      // (everyone, or listed roles and people), not a scope a person requests:
      // a server the actor may not use is not offered at all, not even locked.
      if (locked) continue
    }

    const sdkName = `${key[1]}__${key[2].replace(/[^a-zA-Z0-9_-]/g, "_")}`
    const aliasNames = aliases.get(sdkName)
    results.push({
      sdkName,
      appName: key[1],
      toolName: key[2],
      description: toolDef.description,
      ...(toolDef.searchKeywords?.length ? { keywords: toolDef.searchKeywords } : {}),
      ...(aliasNames ? { aliases: aliasNames } : {}),
      ...(locked ? { locked: true, requiredScope: scopeCheck.missing.join(", ") } : {}),
      ...(toolDef.routineOnly ? { routineOnly: true } : {}),
    })
  }

  return results
}

/**
 * A conditionally gated tool parks itself and returns `{ status: "pending_approval",
 * approval_id, outputs }` as data (execute-tool.ts `withHandlerApprovalOutputs`),
 * not the kernel's blocked envelope. The agent still needs what the blocked
 * message tells it: nothing ran yet, how to chain a step on the @ref tokens,
 * and, in a routine run, that the run waits for the decision.
 */
export function withHandlerApprovalGuidance(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return data
  const d = data as Record<string, unknown>
  if (d.status !== "pending_approval" || typeof d.approval_id !== "string") return data
  if (typeof d.message === "string") return data
  const outputs =
    d.outputs && typeof d.outputs === "object" ? (d.outputs as Record<string, string>) : undefined
  const routinePause = runContextStore.getStore()?.routineId ? ` ${ROUTINE_RUN_PAUSE_CLAUSE}` : ""
  const recipe = sequencingRecipe(outputs)
  return {
    ...d,
    message: `Your call was ACCEPTED but it waits for a person's approval (approval_id), so it HAS NOT RUN yet: do not say it was done and do not call it again.${routinePause}${recipe ? ` ${recipe}` : ""}`,
  }
}
