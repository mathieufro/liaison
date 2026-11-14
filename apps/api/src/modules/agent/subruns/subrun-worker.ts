// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sub-run worker — picks up `agent-subrun` jobs from the kernel queue,
// runs the LLM agent loop with role-scoped tools, validates the finalize
// payload against the run's outputSchema, persists the result, and
// publishes the terminal state for `awaitSubRunResult`.
//
// Wiring:
//   - `registerSubrunWorker()` registers a handler on the kernel queue.
//     `kernel-jobs.ts` calls this at boot.
//   - `startSubrunWorker()` is the public entry test code uses for
//     "ensure a worker is processing the kernel queue in this process";
//     idempotent — calling it more than once is a no-op.
//
// Termination model:
//   - finalize tool call → validate → if valid, mark `done` and publish.
//     If invalid and budget remains, increment schemaRetryCount and let
//     the loop run another step (the AI SDK feeds the tool-result back).
//   - timeout via AbortController → mark `failed/timeout`.
//   - step limit hit without finalize → mark `failed/step_limit`.
//   - clean finish without finalize on a schema run → `failed/schema_failure`.

import { isStepCount } from "ai"
import { and, sql as drizzleSql, eq, ne } from "drizzle-orm"
import Redis from "ioredis"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { agentRuns, messages as kernelMessages, threads as kernelThreads } from "~/db/schema/kernel"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { registerJobWorker } from "~/infra/jobs/jobs"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { publishRedis, REDIS_PREFIX, RESP_PROTOCOL } from "~/lib/redis"
import {
  buildDeferredToolsAnnouncement,
  undeliveredGuideBlocks,
} from "~/modules/agent/context/context"
import { renderGuideNote, renderLoadedToolsBlock } from "~/modules/agent/context/guide-notes"
import {
  checkMidStep,
  finalizeUsage,
  preCheck,
  visitorCostMicroEur,
} from "~/modules/agent/credits/credit-meter"
import {
  redactMailToolArgs,
  redactMailToolResult,
} from "~/modules/agent/mailbox-plaintext/mail-plaintext-redaction"
import {
  CALL_TOOL_SDK_NAME,
  type FixedToolList,
  fixedToolListFrame,
  undeliveredLoadedTools,
} from "~/modules/agent/providers/fixed-tool-list"
import { resolveModelFromCredit } from "~/modules/agent/providers/provider"
import {
  addProviderCostUsd,
  readStepUsage,
  uncachedInputTokens,
} from "~/modules/agent/providers/step-usage"
import {
  AGENT_RUN_INPUT_TOKEN_CAP,
  BACKGROUND_MAX_RETRIES,
  blindCallRepair,
  fixedToolListRepair,
  runAgentStream,
  runawayGuardDecision,
} from "~/modules/agent/runtime/agent-service"
import { clipAndMarkStepMessages } from "~/modules/agent/runtime/rolling-cache-breakpoints"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import {
  accountFromSubRunLimit,
  hardTokenLimitReached,
  hardTokenLimitStopText,
  recordStepTokens,
  refreshTokenAccount,
  type SubRunTokenLimit,
  stepTokens,
} from "~/modules/agent/runtime/run-token-limit"
import type { ClipLedger } from "~/modules/agent/runtime/stale-result-clipper"
import { setTaintFlag } from "~/modules/agent/scopes/taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { injectFinalizeTool, validateFinalizePayload } from "~/modules/agent/subruns/finalize-tool"
import {
  AGENT_SUBRUN_JOB_NAME,
  SpawnAgentError,
  type SubRunJobPayload,
} from "~/modules/agent/subruns/spawn-agent"
import { loadSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import { publishSubRunResult, shapeFromRow } from "~/modules/agent/subruns/subrun-await"
import { assembleSubRunContext, subRunPrompt } from "~/modules/agent/subruns/subrun-context"
import {
  admitLateTools,
  buildScopedToolSet,
  listDeferredTools,
} from "~/modules/agent/tools/tool-bridge"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { primeOrgApps } from "~/modules/apps/org-apps"
import {
  SKIPPED_MOVING,
  sweepSkippingMoving,
  writeUnlessMoving,
} from "~/modules/org/transfer-state/skip-moving"
import { resolveActingAgentIdForWrite } from "~/modules/threads/message"

const log = rootLogger.child({ module: "subrun-worker" })

/**
 * Register the BullMQ handler for `kernel:agent-subrun` jobs. Overwrites the
 * placeholder registered in spawn-agent.ts. Idempotent — consults the live
 * `jobHandlers` map (`isJobWorkerRegistered`) rather than a module-local
 * boolean, so `closeAllQueues()` between test files re-allows registration
 * the next time this is called (the previous boolean-guarded form stuck at
 * `registered=true` while `jobHandlers` was empty, manifesting as "No
 * handler registered for job kernel:agent-subrun" across worker E2E tests
 * that ran after any suite that cleared the registry).
 *
 * Always wins over the placeholder: when both calls land in the same
 * process, the second call wins (the underlying `Map.set`). The placeholder
 * check inside `registerSpawnAgentPlaceholderWorker` defends against the
 * reverse order.
 */
export function registerSubrunWorker(): void {
  registerJobWorker<SubRunJobPayload>("kernel", AGENT_SUBRUN_JOB_NAME, async (payload) =>
    runSubRun(payload.runId, payload.orgId, payload.parentTaintScopes, payload.tokenLimit),
  )
}

/**
 * Test-friendly alias — same as `registerSubrunWorker()`. Tests may call this
 * to be explicit that a worker should be processing in this process.
 */
export async function startSubrunWorker(): Promise<void> {
  registerSubrunWorker()
}

/** Exported for tests — drives a single sub-run by id. Production reaches this
 *  via the registered `agent-subrun` job handler, which passes the parent's
 *  taint from the job payload; without it the run fails closed. */
export async function runSubRun(
  runId: string,
  orgId: string,
  parentTaintScopes?: string[],
  tokenLimit?: SubRunTokenLimit,
): Promise<void> {
  const [run] = await withPrivilegedDb(orgId, "subrun-load", (tx) =>
    tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1),
  )
  if (!run) {
    log.error({ runId, orgId }, "subrun-worker: run not found")
    return
  }

  // Idempotency / terminal-state guard (I-REL-11). A BullMQ retry (or a stale
  // duplicate enqueue) must not re-run the LLM loop or re-deduct credits. If the
  // run already reached a terminal state, republish its stored result so any
  // awaiter that subscribed before this duplicate picked up the job still
  // resolves, then return without re-running. A run still `running` is either
  // genuinely in flight in another worker or a crashed prior attempt; either
  // way re-running here would double-charge, so we refuse and let an operator/
  // timeout sweep recover it.
  if (run.status === "done" || run.status === "failed" || run.status === "cancelled") {
    log.info(
      { runId, orgId, status: run.status },
      "subrun-worker: run already terminal — republishing result, skipping re-run",
    )
    await publishSubRunResult(runId, orgId, shapeFromRow(run))
    return
  }
  if (run.status === "running") {
    log.warn(
      { runId, orgId },
      "subrun-worker: run already marked running — skipping to avoid double-charge",
    )
    return
  }

  // The spawning run's hard token limit (S17, A34). Its counter is shared with
  // the parent, so a sub-run still queued when the limit is already spent ends
  // here, before any model call, and reports the stop to its awaiter.
  const tokenAccount = tokenLimit ? accountFromSubRunLimit(tokenLimit) : undefined
  if (tokenAccount) {
    await refreshTokenAccount(tokenAccount)
    if (hardTokenLimitReached(tokenAccount)) {
      log.info(
        { runId, orgId, used: tokenAccount.used, hardTokenLimit: tokenAccount.hardTokenLimit },
        "subrun-worker: the run's hard token limit is spent, not starting the sub-run",
      )
      await markRunFailed(
        runId,
        orgId,
        "hard_token_limit",
        hardTokenLimitStopText(tokenLimit?.hardTokenLimit ?? 0),
      )
      return
    }
  }
  let stoppedAtHardTokenLimit = false

  // Mark running + broadcast WS status transition (T13). attemptCount is
  // incremented even though BullMQ's `attempts: 1` keeps it at 1 today — the
  // column is reserved for the future per-call `retries: N` capability noted
  // in spec §1.4.7 (M2 hygiene).
  // Only from `queued`: a run cancelled after it was loaded (its caller stopped) stays cancelled.
  const started = await withPrivilegedDb(orgId, "subrun-start", async (tx) =>
    tx
      .update(agentRuns)
      .set({
        status: "running",
        startedAt: new Date(),
        attemptCount: run.attemptCount + 1,
      })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "queued")))
      .returning({ id: agentRuns.id }),
  )
  if (started.length === 0) {
    log.info({ runId, orgId }, "subrun-worker: run left queued before it started, not running it")
    return
  }

  // The sub-run's own tool calls record into this accumulator, so the bridge
  // checks scope taint here exactly as in a chat turn. It starts with the
  // parent's taint from the job payload. A job without it cannot say what the
  // parent had read, so the run fails closed on its effective scope, the part
  // of the parent's scope it can act on. Every hidden-transcript row and the
  // card summary are tagged from it.
  const turnScopeAccumulator = createTurnScopeAccumulator({ orgId })
  if (parentTaintScopes === undefined) {
    log.warn(
      { runId, orgId },
      "subrun-worker: no parent taint on the job, treating the sub-run as tainted",
    )
  }
  turnScopeAccumulator.recordInjected(parentTaintScopes ?? run.effectiveScopes)

  // §1.4.4 step 3 — persist the initial user-role prompt into the hidden
  // thread so an operator who later expands the SubRunCard sees the full
  // back-and-forth. For system actors we fall back to any user in the org
  // (the hidden thread's createdBy was set the same way).
  const promptAuthorId =
    run.actor.actorType === "user" ? run.actor.userId : await resolveAnyOrgUser(orgId)
  if (promptAuthorId) {
    // Fire-and-forget for the same reason as the per-step persistence below
    // (observability only; awaiting blocks the worker for no functional gain).
    void persistHiddenThreadMessage(orgId, {
      threadId: run.threadId,
      authorId: promptAuthorId,
      authorType: "user",
      content: run.prompt,
      metadata: null,
      // The parent's own words: they carry the parent's taint.
      requiredScopes: turnScopeAccumulator.snapshot(),
    }).catch((err) => {
      log.warn({ err, runId, orgId }, "subrun-worker: hidden-thread prompt persist failed")
    })
  }
  await emitSubRunStatus(orgId, runId, "running", run.parentRunId, run.parentThreadId)

  const abortController = new AbortController()
  const timeoutId = setTimeout(() => {
    abortController.abort("timeout")
  }, run.timeoutMs)
  // The caller stopped (cancelSubRunTree): this process or another one asks the run to end.
  const stopListening = listenForSubRunCancel(runId, () => abortController.abort(SUB_RUN_CANCELLED))

  let usagePromptTokens = 0
  let usageCompletionTokens = 0
  let usageCachedInputTokens = 0
  let usageCacheWriteTokens = 0
  let usageCacheWrite5mTokens = 0
  // The USD cost the provider reported (OpenRouter), summed over the steps (step-usage.ts).
  let usageProviderCostUsd: number | null | undefined
  let finalOutput: unknown = null
  let finalText = ""
  let terminatedByFinalize = false
  let schemaRetryCount = run.schemaRetryCount
  let schemaFailedFinal = false
  let lastSchemaError: string | null = null
  // Track step count to distinguish step_limit from schema_failure:
  // - stepCount === maxSteps AND no finalize → loop exhausted budget → step_limit
  // - stepCount  <  maxSteps AND no finalize → model stopped voluntarily → schema_failure
  let stepCount = 0
  let cumulativeUncachedInputTokens = 0
  let tokenWarnLogged = false
  // Last finishReason observed from the AI SDK stream; used as a robust signal
  // for distinguishing voluntary stop from step-budget exhaustion (I5 fix).
  // AI SDK emits "length" / "tool-calls" / "stop" / etc. on `finish-step`
  // chunks; we treat both "length" and (stepCount === maxSteps) as step_limit.
  let lastFinishReason: string | null = null
  // A visitor sub-run's step meter: closed in `finally` on every path (a
  // request already sent is billed even when the run throws).
  let demoMeter: { finish(total?: number): Promise<void> } | undefined

  try {
    if (!run.subagentType) {
      throw new SpawnAgentError("E_UNKNOWN_AGENT_TYPE", "Sub-run row has null subagent_type")
    }

    const def = await loadSubAgentDefinition(orgId, run.subagentType)
    if (!def) {
      throw new SpawnAgentError(
        "E_UNKNOWN_AGENT_TYPE",
        `Definition removed for ${run.subagentType}`,
      )
    }

    // A sub-run is agent work: it runs on the org's Auto setting (A5).
    const credit = await preCheck(orgId, null, { turn: true })
    if (!credit.allowed) {
      // PreCheck can fail for three reasons (M3 fix). Map them to distinct
      // error codes so an operator can tell "out of credits" from "model
      // misconfigured" from "no key" in audit + UI.
      // A demo spend refusal names itself (`demo_*`).
      const code = credit.code
        ? credit.code
        : credit.status === 402
          ? "credits_exhausted"
          : credit.status === 400
            ? "model_unavailable"
            : "provider_misconfigured"
      await markRunFailed(runId, orgId, code, credit.reason)
      return
    }
    demoMeter = credit.demo

    const actor: ActorContext = run.actor

    const context = await assembleSubRunContext({
      run: {
        prompt: run.prompt,
        input: run.input,
        subagentType: run.subagentType,
        threadId: run.threadId,
      },
      def: {
        systemPrompt: def.systemPrompt,
        skills: def.skills,
        mcpServers: def.mcpServers,
      },
      orgId,
      actor,
    })

    // Ensure THIS org's installed app tools (tickets / boxtal / knowledge / …) are
    // registered in this worker process BEFORE assembling the sub-run's toolset.
    // The chat agent does this (agent-service.ts `ensureAppsForOrg` before
    // buildToolSet); the sub-run worker — a separate BullMQ job — previously did
    // NOT, so a sub-run whose org hadn't yet been hydrated in this process built a
    // toolset MISSING its app tools. The sub-agent then reported "the required
    // tools are not currently available" and no-op'd (an empty sub-run), which a
    // fanning-out parent counted as a failure (or, before the empty-output guard,
    // a false success). It is idempotent (guards on initializedOrgRuntimes) so the
    // hydrated case is a cheap no-op; the un-hydrated case is the bug it fixes.
    await ensureAppsForOrg(orgId)
    // The tool set and deferred catalog below read the org's app state (S19).
    await primeOrgApps(orgId)

    // Deferred-tool discovery for NO-ALLOWLIST sub-runs: an explicit allowlist
    // is a small hand-picked surface (send it whole), but a null allowlist used
    // to inline the ENTIRE app-tool schema catalog into every sub-run step.
    // Mirror the chat agent: keep the full set executable, gate what the
    // provider SEES per step via activeTools, unlock via tool_search mid-run.
    const subrunDiscovered = new Set<string>()
    const subRunFrame = {
      turnScopeAccumulator,
      runId,
      parentRunId: run.parentRunId ?? null,
      rootRunId: run.rootRunId,
      nestingDepth: run.nestingDepth,
      // Sub-agent runs are BullMQ kernel:agent-subrun jobs — always background.
      // Tags every tool this sub-run dispatches (buildScopedToolSet →
      // executeWrapper) "background" so it can't starve foreground tool calls.
      background: true,
      ...(def.toolAllowlist == null ? { discoveredTools: subrunDiscovered } : {}),
      // Set below for a discovering sub-run (tool-search.ts calls it).
      admitTools: undefined as RunContext["admitTools"],
      // Every tool the run's set holds, deferred ones included (filled below).
      turnToolNames: new Set<string>(),
      // Set below when the run's tool list is fixed (kernel__call_tool reads it).
      fixedToolList: undefined as RunContext["fixedToolList"],
      // Set once the run's clip ledger exists (web-fetch-repeat.ts reads it).
      clipLedger: undefined as RunContext["clipLedger"],
      // A sub-run's conversation starts empty: its first result of a tool carries the full rule.
      resultHintsShown: new Set<string>(),
      // A nested spawn or ask from this sub-run counts toward the same limit.
      ...(tokenAccount ? { tokenAccount } : {}),
    }
    let tools: Record<string, unknown> = buildScopedToolSet(
      orgId,
      actor,
      run.threadId,
      {
        effectiveScopes: run.effectiveScopes,
        allowlist: def.toolAllowlist,
        denylist: def.toolDenylist,
        skills: def.skills,
      },
      subRunFrame,
    )
    if (run.outputSchema) {
      tools = injectFinalizeTool(tools, run.outputSchema as Record<string, unknown>)
    }
    for (const name of Object.keys(tools)) subRunFrame.turnToolNames.add(name)
    let deferredAnnouncement: string | undefined
    // Discovery gating applies only to null-allowlist sub-runs; an explicit
    // allowlist IS the working set (stable catalog → stable prefix), so gating
    // it would only degrade the sub-agent. Both paths get the same intra-run
    // micro-compaction as the main loop: tool results older than the
    // keep-window are clipped once to the replay cap so a long sub-run doesn't
    // re-bill its own early results on every step (see stale-result-clipper).
    let activeToolsForStep: (() => string[]) | undefined
    let fixedToolList: FixedToolList = null
    if (def.toolAllowlist == null) {
      const scopedActor: ActorContext = { ...actor, scopes: run.effectiveScopes }
      const deferredCatalog = listDeferredTools(orgId, scopedActor)
      const deferredNames = new Set(deferredCatalog.map((t) => t.sdkName))
      activeToolsForStep = () =>
        Object.keys(tools).filter((n) => !deferredNames.has(n) || subrunDiscovered.has(n))
      // A tool registered after the set was built joins it when tool_search
      // loads it, callable on the next step (admitLateTools, tool-bridge.ts).
      subRunFrame.admitTools = (names) => {
        const { admitted, callable } = admitLateTools(names, tools, () =>
          buildScopedToolSet(
            orgId,
            actor,
            run.threadId,
            {
              effectiveScopes: run.effectiveScopes,
              allowlist: def.toolAllowlist,
              denylist: def.toolDenylist,
              skills: def.skills,
            },
            subRunFrame,
          ),
        )
        for (const name of admitted) {
          deferredNames.add(name)
          subRunFrame.turnToolNames.add(name)
        }
        return callable
      }
      if (deferredCatalog.length > 0) {
        deferredAnnouncement = buildDeferredToolsAnnouncement(deferredCatalog)
      }
      // THE RUN'S TOOL LIST IS FIXED, as a thread's is (providers/fixed-tool-list.ts):
      // the provider is shown the tools the run starts with on every step. A
      // tool tool_search loads later is held for the SDK (activeTools still
      // grows) but left out of the list the provider sees; its description and
      // parameters arrive once in a note after the step that loaded it, and the
      // model calls it through kernel__call_tool. Before, each load changed the
      // tool list mid-run and the provider re-read everything after it.
      if (CALL_TOOL_SDK_NAME in tools) {
        const isActive = (name: string) =>
          name in tools && (!deferredNames.has(name) || subrunDiscovered.has(name))
        fixedToolList = new Set(activeToolsForStep())
        subRunFrame.fixedToolList = fixedToolListFrame(fixedToolList, tools, isActive)
      }
    }
    const clippedResultIds: ClipLedger = new Map()
    // A repeat fetch pins the earlier result through it (web-fetch-repeat.ts).
    subRunFrame.clipLedger = clippedResultIds
    const rollingCache = credit.model.provider === "anthropic"
    // The guide parts already sent this run: guides and loaded tools' schemas.
    // The kernel's own guide is the main agent's system prompt; a sub-agent's
    // role prompt stands in its place, so it is never sent here.
    const guidePartsDelivered = new Set<string>(["kernel"])
    /**
     * The note for what the run's loaded tools need and the model lacks, each
     * once; null when nothing is new. A loaded tool's guides (its app's, and a
     * kernel guide naming it) arrive with its first load, as in a thread
     * (agent-service.ts): an allowlisted run loads its whole list at the
     * start, a discovering run a tool at a time through tool_search. A tool
     * the fixed list leaves out also gets its description and parameters.
     */
    const takeGuideNote = (): string | null => {
      const guidedTools = new Set(def.toolAllowlist == null ? subrunDiscovered : Object.keys(tools))
      const guides = undeliveredGuideBlocks(orgId, guidedTools, guidePartsDelivered)
      const parts = [...guides.parts]
      const { loaded, parts: toolParts } =
        fixedToolList && activeToolsForStep
          ? undeliveredLoadedTools(activeToolsForStep(), fixedToolList, tools, guidePartsDelivered)
          : { loaded: [], parts: [] }
      parts.push(...toolParts)
      if (guides.blocks.length === 0 && loaded.length === 0) return null
      for (const part of parts) guidePartsDelivered.add(part)
      return renderGuideNote(
        guides.blocks,
        parts,
        loaded.length > 0 ? renderLoadedToolsBlock(loaded) : undefined,
      )
    }
    const prepareStep = (options: unknown) => {
      const step = options as { messages?: unknown[] } | undefined
      const base = activeToolsForStep ? { activeTools: activeToolsForStep() } : {}
      const note = takeGuideNote()
      if (!Array.isArray(step?.messages)) return base
      // A tool the last step loaded: its guides (and, outside the fixed list,
      // its schema) ride a note right after that step's results; the tools
      // the run starts with get theirs before the first step. The SDK hands this step's
      // messages to the next step with its output appended, so the note keeps
      // its place on every later step (an append-only request).
      const messages = note ? [...step.messages, { role: "user", content: note }] : step.messages
      // The SDK hands back the previous step's override, marks included; they
      // are dropped before the clip and placed again after it.
      const stepList = clipAndMarkStepMessages(messages, clippedResultIds, rollingCache)
      return stepList !== step.messages ? { ...base, messages: stepList } : base
    }

    const result = await runContextStore.run(subRunFrame, async () =>
      runAgentStream({
        // A sub-run stays on its parent thread's OpenRouter upstream host.
        model: await resolveModelFromCredit(credit, {
          providerThreadId: run.parentThreadId ?? run.threadId,
        }),
        stepTokenCap: credit.model.stepTokenCap ?? null,
        ...subRunPrompt(context, deferredAnnouncement),
        tools: tools as never,
        prepareStep,
        fixedToolList,
        ...(def.toolAllowlist == null
          ? { repairToolCall: fixedToolListRepair(blindCallRepair(tools as never), fixedToolList) }
          : {}),
        // Sub-runs are background work — ride out per-minute provider quota
        // windows instead of failing after the SDK's 3 fast attempts.
        maxRetries: BACKGROUND_MAX_RETRIES,
        stopWhen: tokenAccount
          ? [
              isStepCount(run.maxSteps),
              async () => {
                await refreshTokenAccount(tokenAccount)
                if (!hardTokenLimitReached(tokenAccount)) return false
                stoppedAtHardTokenLimit = true
                return true
              },
            ]
          : isStepCount(run.maxSteps),
        abortSignal: abortController.signal,
        onStepFinish: async (step: unknown) => {
          stepCount++
          if (tokenAccount) {
            await recordStepTokens(tokenAccount, stepTokens((step as { usage?: unknown }).usage))
          }
          const s = step as {
            text?: string
            toolCalls?: Array<{
              toolCallId: string
              toolName: string
              input?: unknown
              args?: unknown
            }>
            toolResults?: Array<{
              toolCallId: string
              result: unknown
            }>
          }
          // §1.4.4 step 3 — persist the assistant turn + any tool calls
          // into the hidden thread. `promptAuthorId` was resolved above for
          // the initial prompt and reused as the agent message authorId so
          // FK + RLS constraints are satisfied for system actors. The
          // persistence is intentionally fire-and-forget: it is observability
          // bookkeeping, never on the run's success path, and awaiting it
          // here would slow the onStepFinish callback enough to race the
          // worker's finalize abort against the stream's natural end.
          if (promptAuthorId) {
            const authorId = promptAuthorId
            const hasText = (s.text ?? "").length > 0
            const hasTools = (s.toolCalls ?? []).length > 0
            if (hasText || hasTools) {
              // Everything the child had read by the end of this step, read now:
              // the write below happens after this callback has returned.
              const requiredScopes = turnScopeAccumulator.snapshot()
              void (async () => {
                // Invariant K: what the transcript keeps of a mail tool's call is
                // what a reply keeps. The raw args stay available to `finalize`.
                const stepToolCalls = await Promise.all(
                  (s.toolCalls ?? []).map(async (tc) => {
                    const matchedResult = (s.toolResults ?? []).find(
                      (r) => r.toolCallId === tc.toolCallId,
                    )
                    return {
                      toolCallId: tc.toolCallId,
                      toolName: tc.toolName,
                      args: await redactMailToolArgs(orgId, tc.toolName, tc.input ?? tc.args),
                      result: matchedResult
                        ? await redactMailToolResult(orgId, tc.toolName, matchedResult.result)
                        : undefined,
                      status: matchedResult ? "completed" : "running",
                    }
                  }),
                )
                await persistHiddenThreadMessage(orgId, {
                  threadId: run.threadId,
                  authorId,
                  authorType: "agent",
                  agentId: run.agentId ?? null,
                  content: s.text ?? "",
                  metadata: hasTools ? { toolCalls: stepToolCalls } : null,
                  requiredScopes,
                })
              })().catch((err) => {
                log.warn({ err, runId, orgId }, "subrun-worker: hidden-thread persist failed")
              })
            }
          }

          for (const tc of s.toolCalls ?? []) {
            if (tc.toolName !== "finalize") continue
            const payload = tc.input ?? tc.args
            if (!run.outputSchema) continue
            const validation = validateFinalizePayload(
              payload,
              run.outputSchema as Record<string, unknown>,
            )
            if (validation.ok) {
              finalOutput = payload
              terminatedByFinalize = true
              abortController.abort("finalize")
              return
            }
            schemaRetryCount++
            lastSchemaError = validation.error
            if (schemaRetryCount > run.schemaRetryBudget) {
              schemaFailedFinal = true
              abortController.abort("schema_failure")
              return
            }
          }
          // Runaway guard (same policy as the chat/routine loop): a sub-run past
          // the hard input-token cap is a bug, not load — abort and error-log so
          // the watchdog pages.
          cumulativeUncachedInputTokens += uncachedInputTokens((step as { usage?: unknown }).usage)
          const guard = runawayGuardDecision(cumulativeUncachedInputTokens, tokenWarnLogged)
          if (guard === "warn") {
            tokenWarnLogged = true
            log.warn(
              { runId, orgId, cumulativeUncachedInputTokens },
              "Sub-agent run passed the uncached-input-token warn threshold — runaway suspect",
            )
          } else if (guard === "abort") {
            log.error(
              { runId, orgId, cumulativeUncachedInputTokens, cap: AGENT_RUN_INPUT_TOKEN_CAP },
              "Sub-agent run exceeded the hard uncached-input-token cap — aborting as a runaway (this is a bug to investigate, not normal load)",
            )
            abortController.abort("token_budget_exceeded")
            return
          }
          const mid = await checkMidStep(orgId, credit.keySource)
          if (mid.exhausted) abortController.abort("credits_exhausted")
          // A visitor sub-run on the demo box key: settle this step (always),
          // reserve the next unless the run is already stopping.
          if (credit.demo) {
            const next = await credit.demo.stepFinished(
              (step as { usage?: unknown } | undefined)?.usage,
              (step as { providerMetadata?: unknown } | undefined)?.providerMetadata,
              { reserveNext: !abortController.signal.aborted },
            )
            if (next.exhausted && !abortController.signal.aborted) {
              abortController.abort("credits_exhausted")
            }
          }
        },
      }),
    )

    // Drain the stream — onStepFinish handlers above already ran during streaming
    // for AI SDK v5; the stream iterator yields chunks we still need to walk
    // to accumulate usage and to surface text deltas.
    for await (const chunk of result.fullStream) {
      const c = chunk as {
        type: string
        text?: string
        finishReason?: string
        usage?: unknown
        providerMetadata?: unknown
      }
      if (c.type === "text-delta" && c.text) finalText += c.text
      else if (c.type === "finish-step") {
        const step = readStepUsage(c.usage)
        usagePromptTokens += step.inputTokens ?? 0
        usageCompletionTokens += step.outputTokens ?? 0
        usageCachedInputTokens += step.cacheReadTokens
        if (step.cacheWriteTokens !== undefined) usageCacheWriteTokens += step.cacheWriteTokens
        usageCacheWrite5mTokens += step.cacheWrite5mTokens ?? 0
        usageProviderCostUsd = addProviderCostUsd(usageProviderCostUsd, c.providerMetadata)
        if (typeof c.finishReason === "string") {
          lastFinishReason = c.finishReason
        }
      }
    }

    // Persist running retry counter regardless of outcome.
    if (schemaRetryCount !== run.schemaRetryCount) {
      await withPrivilegedDb(orgId, "subrun-retry-count", (tx) =>
        tx.update(agentRuns).set({ schemaRetryCount }).where(eq(agentRuns.id, runId)),
      )
    }

    if (schemaFailedFinal) {
      await markRunFailed(
        runId,
        orgId,
        "schema_failure",
        lastSchemaError ?? "Final schema validation failed",
      )
      return
    }

    // A sub-run that did NOT finish voluntarily (finalize for schema runs, or a
    // clean stop for hybrid runs) but was ABORTED by an exhaustion condition —
    // timeout, credits, or the step budget — is a FAILURE, regardless of whether
    // it carried an output schema. Detecting this for hybrid (no-schema) runs too
    // is load-bearing: previously the abort-reason check below was guarded by
    // `run.outputSchema`, so a hybrid sub-agent that ran out of step budget (or
    // emitted an empty final turn after a tool call) fell through to the success
    // path and published `ok:true` with empty output — a FALSE SUCCESS. A parent
    // fanning out N sub-agents (one per ticket) then counts those empty stubs as
    // completed work and reports a fabricated count ("all 13 drafted") when several
    // sub-runs in fact produced nothing. The fan-out's honest-count rubric depends
    // on a budget-exhausted sub-run surfacing `ok:false` so the parent can exclude
    // it — so we fail loudly here on both paths rather than masking it as a stub.
    // Cancelled by its caller: cancelSubRunTree already recorded and published the outcome.
    if (abortController.signal.reason === SUB_RUN_CANCELLED) return

    if (!terminatedByFinalize) {
      const reason = abortController.signal.reason
      if (stoppedAtHardTokenLimit && !abortController.signal.aborted) {
        await markRunFailed(
          runId,
          orgId,
          "hard_token_limit",
          hardTokenLimitStopText(tokenLimit?.hardTokenLimit ?? 0),
        )
        return
      }
      if (reason === "timeout") {
        await markRunFailed(runId, orgId, "timeout", `Sub-run timed out after ${run.timeoutMs}ms`)
        return
      }
      if (reason === "credits_exhausted") {
        await markRunFailed(runId, orgId, "credits_exhausted", "Credit balance exhausted mid-run")
        return
      }
      if (reason === "token_budget_exceeded") {
        await markRunFailed(
          runId,
          orgId,
          "token_budget_exceeded",
          `Sub-run exceeded the hard uncached-input-token cap (${AGENT_RUN_INPUT_TOKEN_CAP}) — runaway aborted`,
        )
        return
      }
      // step_limit: the model used up its step budget (stepCount >= maxSteps, or
      // the AI SDK's `length` finish reason) without finishing — a budget
      // exhaustion failure on BOTH schema and hybrid runs. `length` is the AI
      // SDK's "max tokens / steps reached" signal and also discriminates this
      // case (I5 robustness).
      if (stepCount >= run.maxSteps || lastFinishReason === "length") {
        await markRunFailed(
          runId,
          orgId,
          "step_limit",
          `Sub-run exhausted step budget (${run.maxSteps}) without finishing`,
        )
        return
      }
      // A SCHEMA run that ended without a valid finalize (and was not aborted by
      // an exhaustion condition above) is a schema failure. A HYBRID run that
      // stopped voluntarily here is a NORMAL completion — fall through to success.
      if (run.outputSchema) {
        await markRunFailed(
          runId,
          orgId,
          "schema_failure",
          lastSchemaError ?? "Run ended without finalize",
        )
        return
      }
    }

    if (!run.outputSchema) {
      // Hybrid mode — use last assistant text as the output for runs without
      // a schema (rare for sub-agents but supported).
      finalOutput = finalText

      // A hybrid sub-run that stopped voluntarily but produced NO output at all
      // (empty/whitespace finalText — the degenerate "spawned, did nothing" no-op
      // the judge flagged: ~47 completion tokens, no tool call, no draft) is NOT a
      // real completion. Publishing it as ok:true with an empty output lets a
      // fanning-out parent count it as a finished unit and over-state the count
      // ("all 12 drafted" when several sub-runs queued nothing). A sub-agent that
      // genuinely did its job returns either a non-empty summary OR a side effect
      // (a queued gated approval) — an empty-output clean stop is neither, so we
      // surface it as ok:false (empty_output) and the parent honestly excludes it.
      // A real summarizer/formatter sub-agent always emits non-empty text, so this
      // never false-negatives a legitimate no-side-effect role.
      if (typeof finalOutput === "string" && finalOutput.trim().length === 0) {
        await markRunFailed(
          runId,
          orgId,
          "empty_output",
          "Sub-run finished without producing any output (no text, no draft) — degenerate no-op",
        )
        return
      }
    }

    const usageUserId = actor.actorType === "user" ? actor.userId : await resolveAnyOrgUser(orgId)

    let creditCost = "0"
    if (usageUserId) {
      const usageRec = await finalizeUsage(orgId, {
        model: credit.model,
        inputTokens: usagePromptTokens,
        outputTokens: usageCompletionTokens,
        cachedInputTokens: usageCachedInputTokens,
        cacheWriteTokens: usageCacheWriteTokens,
        cacheWrite5mTokens: usageCacheWrite5mTokens,
        providerCostUsd: usageProviderCostUsd ?? undefined,
        keySource: credit.keySource,
        userId: usageUserId,
        ...(credit.demo ? { demo: credit.demo } : {}),
      })
      creditCost = usageRec.creditCost
    } else if (credit.demo) {
      // No usage row to land, but the visitor's spend settles all the same.
      await credit.demo.finish(
        visitorCostMicroEur({
          inputTokens: usagePromptTokens,
          outputTokens: usageCompletionTokens,
          cachedInputTokens: usageCachedInputTokens,
          providerCostUsd: usageProviderCostUsd ?? null,
        }),
      )
    }

    const summary = computeSummary(finalOutput)
    // The summary quotes the child's output, so the card that shows it needs
    // the child's final scopes on top of the parent's taint it was written
    // with. Re-tagged before the run is marked done, so a failure here fails
    // the run rather than publishing an under-tagged summary.
    const cardRequiredScopes = await retagSubRunCard(
      orgId,
      runId,
      run.parentThreadId,
      turnScopeAccumulator.snapshot(),
    )

    await withPrivilegedDb(orgId, "subrun-done", (tx) =>
      tx
        .update(agentRuns)
        .set({
          status: "done",
          output: finalOutput as Record<string, unknown> | null,
          summary,
          usagePromptTokens,
          usageCompletionTokens,
          creditCost,
          finishedAt: new Date(),
        })
        .where(and(eq(agentRuns.id, runId), ne(agentRuns.status, "cancelled"))),
    )
    if (abortController.signal.reason === SUB_RUN_CANCELLED) return

    await publishSubRunResult(runId, orgId, {
      ok: true,
      runId,
      output: finalOutput,
      summary,
      usage: {
        promptTokens: usagePromptTokens,
        completionTokens: usageCompletionTokens,
        creditCost,
      },
    })
    // Delivery gives the summary only to participants who can see the card
    // (WebSocketManager.redactSubRunSummary); everyone else gets the status.
    await emitSubRunStatus(orgId, runId, "done", run.parentRunId, run.parentThreadId, {
      requiredScopes: cardRequiredScopes,
      summary,
      usage: {
        promptTokens: usagePromptTokens,
        completionTokens: usageCompletionTokens,
        creditCost,
      },
    })
  } catch (err) {
    if (abortController.signal.reason === SUB_RUN_CANCELLED) {
      log.info({ runId, orgId }, "subrun-worker: run cancelled by its caller")
      return
    }
    const code =
      err instanceof SpawnAgentError
        ? err.code
        : typeof (err as { code?: unknown })?.code === "string"
          ? (err as { code: string }).code
          : "unknown"
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ err, runId, orgId }, "subrun-worker: run failed")
    // Guard the failure-recording path itself. If `markRunFailed` throws (DB
    // write fails, or the publish/emit inside it rejects), the run would
    // otherwise stay `running` forever and the awaiting parent stalls until its
    // own ~600s timeout (B12b). Swallow + log here so a failure to RECORD the
    // failure can't wedge the run; the stuck-run sweep (`sweepStuckSubRuns`)
    // is the backstop that eventually terminalizes any row left `running`.
    try {
      await markRunFailed(runId, orgId, code, msg)
    } catch (markErr) {
      log.error(
        { err: markErr, runId, orgId, code, originalError: msg },
        "subrun-worker: markRunFailed threw while recording run failure — " +
          "run left for the stuck-run sweep to reclaim",
      )
    }
  } finally {
    clearTimeout(timeoutId)
    stopListening()
    await demoMeter?.finish()
    // Propagate taint upward across the spawn boundary. If a tool tainted the
    // hidden subrun thread during this run (e.g. the sub-agent fetched a web
    // page), the structured result folded back into the parent thread carries
    // that untrusted provenance — so the parent must become tainted too, on
    // both success and failure paths.
    await propagateTaintToParent(orgId, run.threadId, run.parentThreadId).catch(async (err) => {
      // Fail closed: a propagation failure means we could not confirm whether the
      // hidden subrun thread tainted the parent. Silently leaving the parent clean
      // would let a subsequent trust-boundary tool (e.g. send_email) run without
      // prompt-injection gating after a sub-agent fetched untrusted content. So we
      // escalate to error and conservatively taint the parent directly — a
      // false-positive taint only tightens gating, which is the safe direction.
      log.error(
        { err, runId, orgId, parentThreadId: run.parentThreadId },
        "subrun-worker: taint propagation to parent failed — failing closed by tainting parent",
      )
      if (run.parentThreadId) {
        await setTaintFlag(run.parentThreadId, orgId).catch((flagErr) =>
          log.error(
            { err: flagErr, runId, orgId, parentThreadId: run.parentThreadId },
            "subrun-worker: fail-closed parent taint also failed — parent may run untainted",
          ),
        )
      }
    })
  }
}

/**
 * Backstop sweep for sub-runs wedged in `running` (B12b). A sub-run is normally
 * terminalized by the worker itself (done / one of the failure codes) inside an
 * AbortController-driven timeout. But if the worker process crashes mid-run, or
 * the failure-recording path (`markRunFailed`) itself throws after the loop has
 * died, the row stays `running` forever and the awaiting parent stalls until its
 * own ~600s `awaitSubRunResult` deadline. This sweep reclaims any such row whose
 * `running` lifetime has exceeded its own `timeoutMs` (the same budget the
 * AbortController enforces) and terminalizes it as `failed/timeout`, publishing
 * the result + emitting the WS transition so a still-waiting parent resolves
 * immediately rather than waiting out its full deadline.
 *
 * Cross-org scan (mirrors `runApprovingReaper`): a single `withSystemDb` SELECT
 * finds stale rows across every org, then each row is terminalized under its own
 * `withPrivilegedDb` org context. The UPDATE is guarded by `status = 'running'`
 * so a worker that finishes the run in the same window (or another sweep tick)
 * never clobbers a row that already reached a terminal state — only rows this
 * sweep actually transitions are published/emitted.
 *
 * Wired by `kernel-jobs.ts` as a periodic scheduled job alongside the approval
 * reapers.
 */
export async function sweepStuckSubRuns(): Promise<void> {
  // An org being moved keeps its runs as they are until the move ends.
  // `started_at` is set when the worker marks the run `running`; if it is
  // somehow null (a row that reached `running` without a start timestamp), fall
  // back to `created_at` so the row is still eligible for reclamation. The
  // budget compared against is the row's own `timeout_ms` (milliseconds).
  const stale = await sweepSkippingMoving((notMoving) =>
    withSystemDb("subrun-stuck-sweep-scan", (db) =>
      db
        .select({
          id: agentRuns.id,
          orgId: agentRuns.orgId,
          timeoutMs: agentRuns.timeoutMs,
          parentRunId: agentRuns.parentRunId,
          parentThreadId: agentRuns.parentThreadId,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.status, "running"),
            notMoving(agentRuns.orgId),
            drizzleSql`COALESCE(${agentRuns.startedAt}, ${agentRuns.createdAt}) < now() - make_interval(secs => ${agentRuns.timeoutMs} / 1000.0)`,
          ),
        )
        .limit(100),
    ),
  )

  for (const row of stale) {
    try {
      // Race-safe terminalize: only flip rows still `running`. A worker that
      // completed (or another sweep tick) in the same window leaves the row
      // terminal, the UPDATE matches nothing, and we skip publish/emit for it.
      const updated = await writeUnlessMoving(row.orgId, () =>
        withPrivilegedDb(row.orgId, "subrun-stuck-sweep-fail", (tx) =>
          tx
            .update(agentRuns)
            .set({
              status: "failed",
              errorCode: "timeout",
              errorMessage: `Sub-run reclaimed by stuck-run sweep after exceeding ${row.timeoutMs}ms in running`,
              finishedAt: new Date(),
            })
            .where(and(eq(agentRuns.id, row.id), eq(agentRuns.status, "running")))
            .returning({ id: agentRuns.id }),
        ),
      )
      if (updated === SKIPPED_MOVING || updated.length === 0) continue

      const error = {
        code: "timeout",
        message: `Sub-run reclaimed by stuck-run sweep after exceeding ${row.timeoutMs}ms in running`,
      }
      log.error(
        { runId: row.id, orgId: row.orgId, timeoutMs: row.timeoutMs },
        "subrun-worker: stuck-run sweep reclaimed a run wedged in running",
      )
      // Wake any awaiting parent immediately (and update the UI) — mirror the
      // publish + emit `markRunFailed` does. Wrapped so a publish/emit failure
      // on one row doesn't abort the rest of the sweep; the row is already
      // terminal in the DB so the parent's race-fallback poll still recovers it.
      try {
        await publishSubRunResult(row.id, row.orgId, {
          ok: false,
          runId: row.id,
          output: null,
          summary: null,
          usage: { promptTokens: 0, completionTokens: 0, creditCost: "0" },
          error,
        })
        await emitSubRunStatus(row.orgId, row.id, "failed", row.parentRunId, row.parentThreadId, {
          error,
        })
      } catch (notifyErr) {
        log.warn(
          { err: notifyErr, runId: row.id, orgId: row.orgId },
          "subrun-worker: stuck-run sweep publish/emit failed (row already terminalized)",
        )
      }
    } catch (err) {
      log.error(
        { err, runId: row.id, orgId: row.orgId },
        "subrun-worker: stuck-run sweep failed for row",
      )
    }
  }
}

/**
 * When the hidden subrun thread became tainted during the run, mark the parent
 * thread tainted as well so trust-boundary tools in the parent keep their
 * prompt-injection protection. No-op when the subrun is clean or has no parent
 * thread (root spawns from a routine without a surface thread).
 */
export async function propagateTaintToParent(
  orgId: string,
  hiddenThreadId: string,
  parentThreadId: string | null,
): Promise<void> {
  if (!parentThreadId) return
  const [hidden] = await withPrivilegedDb(orgId, "subrun-taint-read", (tx) =>
    tx
      .select({ tainted: kernelThreads.tainted })
      .from(kernelThreads)
      .where(eq(kernelThreads.id, hiddenThreadId))
      .limit(1),
  )
  if (!hidden?.tainted) return
  const [parent] = await withPrivilegedDb(orgId, "subrun-taint-parent-read", (tx) =>
    tx
      .select({ tainted: kernelThreads.tainted })
      .from(kernelThreads)
      .where(eq(kernelThreads.id, parentThreadId))
      .limit(1),
  )
  // Already tainted — nothing to do (avoids a redundant write + WS broadcast).
  if (parent?.tainted) return
  await setTaintFlag(parentThreadId, orgId)
}

function computeSummary(output: unknown): string | null {
  if (output && typeof output === "object" && "summary" in (output as object)) {
    const s = (output as { summary?: unknown }).summary
    if (typeof s === "string") return s.slice(0, 200)
  }
  if (typeof output === "string") return output.slice(0, 200)
  try {
    return JSON.stringify(output).slice(0, 200)
  } catch {
    return null
  }
}

async function markRunFailed(
  runId: string,
  orgId: string,
  code: string,
  message: string,
): Promise<void> {
  // A cancelled run stays cancelled: its canceller already published the outcome.
  const [row] = await withPrivilegedDb(orgId, "subrun-fail", async (tx) =>
    tx
      .update(agentRuns)
      .set({
        status: "failed",
        errorCode: code,
        errorMessage: message,
        finishedAt: new Date(),
      })
      .where(and(eq(agentRuns.id, runId), ne(agentRuns.status, "cancelled")))
      .returning({
        parentRunId: agentRuns.parentRunId,
        parentThreadId: agentRuns.parentThreadId,
      }),
  )
  if (!row) return
  await publishSubRunResult(runId, orgId, {
    ok: false,
    runId,
    output: null,
    summary: null,
    usage: { promptTokens: 0, completionTokens: 0, creditCost: "0" },
    error: { code, message },
  })
  await emitSubRunStatus(
    orgId,
    runId,
    "failed",
    row?.parentRunId ?? null,
    row?.parentThreadId ?? null,
    {
      error: { code, message },
    },
  )
}

/**
 * T13 — Broadcast a sub-run status transition as an ephemeral WS event. The
 * frontend `messages` store subscribes to `kernel:sub_run:update` events and
 * updates `metadata.subRun` for the matching message in place.
 *
 * `parentRunId` is forwarded so the frontend can locate the originating
 * thread's sub_run message without an extra fetch.
 */
const SUB_RUN_TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"])

export async function emitSubRunStatus(
  orgId: string,
  runId: string,
  status: "queued" | "running" | "done" | "failed" | "cancelled",
  parentRunId: string | null,
  parentThreadId: string | null,
  extras?: Record<string, unknown>,
): Promise<void> {
  // Frame shape is IDENTICAL across both paths (flat runId/parentRunId/
  // parentThreadId/status/...extras) so the frontend `handleWsSubRunUpdate`
  // handler applies either verbatim — only the delivery guarantee differs.
  const data = {
    runId,
    parentRunId,
    parentThreadId,
    status,
    ...(extras ?? {}),
  }

  // The card row is the state a reader loads: a thread fetched after this
  // transition (a reload, a reconnect, a refetch racing the frame) must show
  // it, or the card reads `queued` forever once the live frame is gone.
  await persistSubRunCardState(orgId, runId, parentThreadId, status, extras)

  // F2 — terminal transitions (done|failed|cancelled) are DURABLE: they must
  // survive a crash and replay on reconnect, or a client that closed its laptop
  // mid-run sees the sub-run card frozen forever. Route them through the
  // transactional outbox (tx.queueEvent inside a privileged tx that carries the
  // outbox helper). Non-terminal deltas (queued -> running) stay EPHEMERAL —
  // they are transient progress with no lasting state to reconcile.
  //
  // BEST-EFFORT: this helper is called from each caller AFTER its own tx has
  // committed the terminal STATUS row on `agent_runs` (subrun-done / markRunFailed
  // / the stuck sweep), so the queueEvent here rides a SEPARATE privileged tx and
  // is not atomic with that status commit. Ideally it would ride the same tx that
  // stamps the status (see auto-title.ts, which does UPDATE + tx.queueEvent
  // atomically) — but the status commit is not in scope of this shared helper, so
  // a durable-emit failure here is best-effort: the authoritative status is
  // already persisted, and a reconnecting client re-reads it via the normal
  // hydration path even if this WS frame is lost. Log at ERROR (not WARN) so a
  // silently-dropped terminal frame is visible as a field-reportable issue.
  if (SUB_RUN_TERMINAL_STATUSES.has(status)) {
    try {
      await withPrivilegedDb(orgId, `subrun-emit-terminal:${status}`, async (tx) => {
        // A11 (X11): this emit runs after the run's own transaction and OUTSIDE
        // the sub-run frame, so no live context can say which agent the work
        // belonged to. The run ROW carries it (persisted at spawn), so read it
        // back here. Null stays null: a run no agent spawned records none.
        const [run] = await tx
          .select({ agentId: agentRuns.agentId })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId))
          .limit(1)
        await tx.queueEvent({
          app: "kernel",
          entity: "sub_run",
          action: "update",
          entityId: runId,
          orgId,
          actorId: null,
          actorType: "system",
          agentId: run?.agentId ?? null,
          data,
        })
      })
    } catch (err) {
      log.error(
        { err, runId, orgId, status },
        "subrun-worker: durable sub_run terminal emit failed (best-effort — status already committed)",
      )
    }
    return
  }

  try {
    await broadcastEphemeral({
      app: "kernel",
      entity: "sub_run",
      action: "update",
      entityId: runId,
      orgId,
      actorId: null,
      actorType: "system",
      data,
    })
  } catch (err) {
    log.warn({ err, runId, orgId, status }, "subrun-worker: broadcastEphemeral failed")
  }
}

/**
 * Writes a status transition onto the parent thread's sub_run card row
 * (`metadata.subRun.{status,summary,usage,error}`), the same fields the live
 * frame patches in the client. The summary is written only after the done path
 * re-tagged the card with the child's scopes (`retagSubRunCard`), so the row's
 * read filter already covers it. Best-effort, like the emit: the run row holds
 * the authoritative status.
 */
async function persistSubRunCardState(
  orgId: string,
  runId: string,
  parentThreadId: string | null,
  status: "queued" | "running" | "done" | "failed" | "cancelled",
  extras?: Record<string, unknown>,
): Promise<void> {
  if (!parentThreadId) return
  const patch: Record<string, unknown> = { status }
  for (const key of ["summary", "usage", "error"] as const) {
    if (extras && extras[key] !== undefined) patch[key] = extras[key]
  }
  try {
    await withPrivilegedDb(orgId, "subrun-card-state", async (tx) => {
      await tx
        .update(kernelMessages)
        .set({
          metadata: drizzleSql`jsonb_set(${kernelMessages.metadata}, '{subRun}', coalesce(${kernelMessages.metadata} -> 'subRun', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
        })
        .where(
          and(
            eq(kernelMessages.orgId, orgId),
            eq(kernelMessages.threadId, parentThreadId),
            drizzleSql`${kernelMessages.metadata} ->> 'kind' = 'sub_run'`,
            drizzleSql`${kernelMessages.metadata} -> 'subRun' ->> 'runId' = ${runId}`,
          ),
        )
    })
  } catch (err) {
    log.error(
      { err, runId, orgId, status },
      "subrun-worker: sub_run card state write failed (run row already holds the status)",
    )
  }
}

async function resolveAnyOrgUser(orgId: string): Promise<string | null> {
  const { users: kernelUsers } = await import("~/db/schema/kernel")
  const [u] = await withPrivilegedDb(orgId, "subrun-resolve-user", (tx) =>
    tx
      .select({ id: kernelUsers.id })
      .from(kernelUsers)
      .where(eq(kernelUsers.orgId, orgId))
      .limit(1),
  )
  return u?.id ?? null
}

/**
 * Persist a single message into a hidden sub-run thread. Privileged write so
 * RLS doesn't block when the actor is `system` (no userId set in GUC) — sub-run
 * transcripts must always be writable from the worker regardless of who the
 * caller actor is. The hidden thread itself is `hidden_from_list=true` and is
 * only readable by participants of the chain's root surface thread (see
 * §1.4.4 + `listMessages` exception). Each row carries the child's
 * accumulated scopes at write time, which that read applies per viewer.
 */
async function persistHiddenThreadMessage(
  orgId: string,
  params: {
    threadId: string
    authorId: string
    authorType: "user" | "agent" | "system"
    content: string
    metadata: Record<string, unknown> | null
    requiredScopes: string[]
    /** The child run's own agent (agent_runs.agent_id), for its agent rows (A8). */
    agentId?: string | null
  },
): Promise<void> {
  await withPrivilegedDb(orgId, "subrun-hidden-msg", async (tx) => {
    // This write runs outside the child's frame (a fire-and-forget hop), so the
    // agent is handed over from the run row; the shared resolver falls back to
    // the prompt author's personal agent, exactly as the surface-thread writer
    // does. An agent row that names nobody is refused by the database.
    const authorAgentId = await resolveActingAgentIdForWrite(tx, {
      orgId,
      userId: params.authorId,
      authorType: params.authorType,
      agentId: params.agentId,
    })
    await tx.insert(kernelMessages).values({
      threadId: params.threadId,
      orgId,
      authorId: params.authorId,
      authorType: params.authorType,
      content: params.content,
      metadata: params.metadata as Record<string, unknown> | null,
      requiredScopes: params.requiredScopes,
      authorAgentId: params.authorType === "agent" ? authorAgentId : null,
    })
  })
}

/**
 * Re-tags the parent thread's sub_run card with the union of its own
 * requiredScopes (the parent's taint at spawn) and the child's final scopes,
 * because the summary the card now shows quotes the child's output. Returns
 * the tag the summary travels with. Without a parent thread there is no card
 * and the child's scopes are the tag.
 */
async function retagSubRunCard(
  orgId: string,
  runId: string,
  parentThreadId: string | null,
  childScopes: string[],
): Promise<string[]> {
  if (!parentThreadId) return [...new Set(childScopes)].sort()
  return withPrivilegedDb(orgId, "subrun-card-retag", async (tx) => {
    const card = and(
      eq(kernelMessages.orgId, orgId),
      eq(kernelMessages.threadId, parentThreadId),
      drizzleSql`${kernelMessages.metadata} ->> 'kind' = 'sub_run'`,
      drizzleSql`${kernelMessages.metadata} -> 'subRun' ->> 'runId' = ${runId}`,
    )
    const rows = await tx
      .select({ requiredScopes: kernelMessages.requiredScopes })
      .from(kernelMessages)
      .where(card)
    const tag = [...new Set([...childScopes, ...rows.flatMap((r) => r.requiredScopes)])].sort()
    if (rows.length > 0) {
      await tx.update(kernelMessages).set({ requiredScopes: tag }).where(card)
    }
    return tag
  })
}

// --- Cancellation (the caller stopped) -----------------------------------------
//
// A chat turn, or a parent sub-run, that is awaiting a sub-run can be stopped. The sub-run ends
// with it, and so does every run it spawned: `cancelSubRunTree` marks the run and its descendants
// (by parent_run_id) `cancelled`, publishes each one's outcome to its awaiter, and asks the worker
// running it to abort, in this process directly and in any other one over Redis.

/** The abort reason a cancelled run's controller carries. */
export const SUB_RUN_CANCELLED = "cancelled"

const liveCancelHandlers = new Map<string, () => void>()
let cancelSubscriber: Redis | null = null

function cancelChannel(runId: string): string {
  return `${REDIS_PREFIX}agent-run-cancel:${runId}`
}

function ensureCancelSubscriber(): Promise<Redis> {
  if (cancelSubscriber) return Promise.resolve(cancelSubscriber)
  // No keyPrefix: the channel is prefixed by hand, as subrun-await's subscriber does.
  const sub = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    protocol: RESP_PROTOCOL,
  })
  sub.on("message", (channel: string) => {
    const runId = channel.slice(cancelChannel("").length)
    liveCancelHandlers.get(runId)?.()
  })
  sub.on("error", (err) => log.warn({ err }, "subrun-worker: cancel subscriber error"))
  cancelSubscriber = sub
  return Promise.resolve(sub)
}

/**
 * While a run executes here, a cancel for it calls `onCancel`. Returns the stop function. The
 * Redis subscription is not awaited: the run never waits on it, and a cancel issued in this process
 * reaches the run through the in-process map either way.
 */
function listenForSubRunCancel(runId: string, onCancel: () => void): () => void {
  liveCancelHandlers.set(runId, onCancel)
  let stopped = false
  const subscribed = ensureCancelSubscriber()
    .then(async (sub) => {
      await sub.subscribe(cancelChannel(runId))
      if (stopped) await sub.unsubscribe(cancelChannel(runId))
      return true
    })
    .catch((err: unknown) => {
      // Another process's cancel then falls back to the run's own timeout; logged so a lost
      // cross-process cancel is visible.
      log.warn({ err, runId }, "subrun-worker: could not listen for a cancel over Redis")
      return false
    })
  return () => {
    stopped = true
    liveCancelHandlers.delete(runId)
    void subscribed.then((ok) => {
      if (ok) {
        cancelSubscriber?.unsubscribe(cancelChannel(runId)).catch((err: unknown) => {
          log.warn({ err, runId }, "subrun-worker: cancel unsubscribe failed")
        })
      }
    })
  }
}

/**
 * Cancel a sub-run and every run below it that has not finished. Returns the ids it cancelled.
 * Idempotent: a run already terminal is left as it is.
 */
export async function cancelSubRunTree(
  runId: string,
  orgId: string,
  message = "Stopped: the run that was waiting for it was stopped.",
): Promise<string[]> {
  const cancelled = await withPrivilegedDb(orgId, "subrun-cancel", async (tx) =>
    extractRows<{ id: string; parent_run_id: string | null; parent_thread_id: string | null }>(
      await tx.execute(drizzleSql`
        WITH RECURSIVE tree AS (
          SELECT id FROM ${agentRuns} WHERE id = ${runId} AND org_id = ${orgId}
          UNION
          SELECT r.id FROM ${agentRuns} r JOIN tree t ON r.parent_run_id = t.id
          WHERE r.org_id = ${orgId}
        )
        UPDATE ${agentRuns} SET status = 'cancelled', error_code = 'cancelled',
          error_message = ${message}, finished_at = now()
        WHERE id IN (SELECT id FROM tree) AND status IN ('queued', 'running')
        RETURNING id, parent_run_id, parent_thread_id`),
    ),
  )
  for (const row of cancelled) {
    liveCancelHandlers.get(row.id)?.()
    await publishRedis(cancelChannel(row.id), "1").catch((err: unknown) =>
      log.warn({ err, runId: row.id }, "subrun-worker: cancel publish failed"),
    )
    await publishSubRunResult(row.id, orgId, {
      ok: false,
      runId: row.id,
      output: null,
      summary: null,
      usage: { promptTokens: 0, completionTokens: 0, creditCost: "0" },
      error: { code: "cancelled", message },
    })
    await emitSubRunStatus(orgId, row.id, "cancelled", row.parent_run_id, row.parent_thread_id, {
      error: { code: "cancelled", message },
    }).catch((err: unknown) =>
      log.error({ err, runId: row.id }, "subrun-worker: cancelled status emit failed"),
    )
  }
  if (cancelled.length > 0) {
    log.info({ runId, orgId, cancelled: cancelled.length }, "subrun-worker: sub-run tree cancelled")
  }
  return cancelled.map((r) => r.id)
}
