// SPDX-License-Identifier: FSL-1.1-ALv2

import { generateText, isStepCount, tool } from "ai"
import { and, asc, eq, isNull } from "drizzle-orm"
import { z } from "zod"
import { withPrivilegedDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { messages, threads } from "~/db/schema/kernel"
import { isTestEnv } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { labelsForRegion } from "~/modules/agent/context/agent-attribution"
import { convertToCoreMessages } from "~/modules/agent/context/context"
import {
  type DemoStepMeter,
  finalizeUsage,
  meterSideCall,
  preCheck,
  selectSideCallModelForOrg,
} from "~/modules/agent/credits/credit-meter"
import { handleMemoryGet, handleMemorySet } from "~/modules/agent/memory/memory"
import { fileToRow } from "~/modules/agent/memory/memory-tree"
import { resolveSideCallModel, sideCallUsage } from "~/modules/agent/providers/side-call-model"
import { addProviderCostUsd } from "~/modules/agent/providers/step-usage"
import { replaysOutsideText } from "~/modules/agent/scopes/replayed-outside-text"
import { projectTaintScopesForOrg } from "~/modules/agent/scopes/taint-read-scopes"
import { assertExplicitRequiredScopes } from "~/modules/threads/message"

const log = rootLogger.child({ module: "compaction" })
const COMPACTION_THRESHOLD = 0.8
const compactingThreads = new Set<string>()

export function shouldCompact(lastInputTokens: number, contextWindow: number): boolean {
  if (lastInputTokens === 0) return false
  return lastInputTokens >= COMPACTION_THRESHOLD * contextWindow
}

type AgentMessage = { role: string; content: unknown }

export function pruneMessages(msgs: AgentMessage[]): AgentMessage[] {
  const assistantIndices: number[] = []
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "assistant") assistantIndices.push(i)
  }

  // Keep last 2 assistant turns verbatim
  const keepFromIndex =
    assistantIndices.length >= 2 ? assistantIndices[assistantIndices.length - 2] : 0

  return msgs.map((msg, i) => {
    if (i >= keepFromIndex) return msg
    if (msg.role !== "assistant" || typeof msg.content === "string") return msg

    const parts = msg.content as Array<any>
    const toolCalls = parts.filter((p: any) => p.type === "tool-call")
    if (toolCalls.length === 0) return msg

    const summary = toolCalls.map((tc: any) => `Called ${tc.toolName}`).join(", ")
    const textParts = parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join(" ")
    return { role: "assistant", content: `${textParts} [${summary}]`.trim() }
  })
}

export function aggressivePrune(msgs: AgentMessage[]): AgentMessage[] {
  const maxMessages = 20
  if (msgs.length <= maxMessages) return msgs
  const sliced = msgs.slice(msgs.length - maxMessages)
  // A raw tail slice can land between an assistant tool-call message and the
  // `role:"tool"` result that `convertToCoreMessages` emits right after it,
  // leaving the window starting with an orphaned tool-result. Providers reject
  // that ("tool_result must follow tool_use"), so drop any leading orphaned
  // tool-result messages until the window opens on a valid boundary.
  let start = 0
  while (start < sliced.length && sliced[start].role === "tool") start++
  return start === 0 ? sliced : sliced.slice(start)
}

// Hard input guard: neither the Step 1 memory-flush call nor the Step 3
// summarize call may ever send a prompt larger than this fraction of the
// COMPACTION model's own context window. Without a cap, a thread whose full
// pruned history exceeds the compaction model's window makes the summarize
// call itself throw — and since compaction re-runs (and re-fails) on every
// subsequent turn, the thread is permanently bricked. 50% leaves headroom for
// the system prompt, the model's output tokens, and the token-estimate's
// inherent slack (a chars/4 heuristic, not an exact tokenizer count).
export const COMPACTION_INPUT_BUDGET_FRACTION = 0.5
const EARLIER_TRUNCATED_MARKER = "[earlier conversation truncated for length]"

/** Cheap chars/4 token estimate — consistent with the existing heuristic used
 *  elsewhere in the codebase (see apps/tickets/summary.ts capMessages). Good
 *  enough for a hard safety budget; it does not need to match the real
 *  tokenizer exactly, only to keep the prompt well under the model's window. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function serializeMessages(msgs: AgentMessage[]): string {
  return msgs
    .map(
      (m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
    )
    .join("\n\n")
}

/**
 * Deterministically shrink `msgs` until its serialized size fits within
 * `budgetTokens`, WITHOUT ever returning an over-budget result:
 *
 * 1. If already within budget, return as-is (nothing dropped, no marker).
 * 2. Otherwise apply the existing `aggressivePrune` (last-20-messages window).
 * 3. If STILL over budget, head-drop the oldest of the remaining messages
 *    (keeping the most recent turns) until the tail fits, and prepend a clear
 *    truncation marker so the model (and anyone reading the summary) knows
 *    earlier context was cut.
 *
 * Used as a hard guard in front of BOTH the Step 1 memory-flush call and the
 * Step 3 summarize call — neither may ever send an over-budget prompt.
 */
export function fitMessagesToBudget(
  msgs: AgentMessage[],
  budgetTokens: number,
): { messages: AgentMessage[]; truncated: boolean; estimatedTokens: number } {
  if (estimateTokens(serializeMessages(msgs)) <= budgetTokens) {
    return {
      messages: msgs,
      truncated: false,
      estimatedTokens: estimateTokens(serializeMessages(msgs)),
    }
  }

  let candidate = aggressivePrune(msgs)
  if (estimateTokens(serializeMessages(candidate)) <= budgetTokens) {
    return {
      messages: candidate,
      truncated: candidate.length < msgs.length,
      estimatedTokens: estimateTokens(serializeMessages(candidate)),
    }
  }

  // Still over budget after aggressivePrune (a genuinely enormous history, or
  // very large individual messages within the last-20 window): head-drop the
  // oldest remaining messages one at a time, keeping the most recent turns,
  // until the tail fits. This always terminates — in the worst case only the
  // single most recent message remains, which the caller's own downstream
  // model call would reject anyway, but we never hand back something over
  // the budget we were asked to enforce.
  while (candidate.length > 1 && estimateTokens(serializeMessages(candidate)) > budgetTokens) {
    candidate = candidate.slice(1)
  }

  return {
    messages: [{ role: "user", content: EARLIER_TRUNCATED_MARKER }, ...candidate],
    truncated: true,
    estimatedTokens:
      estimateTokens(serializeMessages(candidate)) + estimateTokens(EARLIER_TRUNCATED_MARKER),
  }
}

export async function persistCompactionSummary(params: {
  threadId: string
  orgId: string
  userId: string
  summary: string
  /** The union of the requiredScopes of every message the summary covers. */
  requiredScopes: string[]
  /** The summarised messages carried outside text (scopes/replayed-outside-text.ts). */
  tainted?: boolean
}): Promise<void> {
  assertExplicitRequiredScopes(params.requiredScopes)
  await withPrivilegedDb(params.orgId, "persist-compaction-summary", async (tx) => {
    await tx.insert(messages).values({
      threadId: params.threadId,
      orgId: params.orgId,
      authorId: params.userId,
      authorType: "system",
      content: params.summary,
      metadata: { type: "compaction_summary", ...(params.tainted ? { tainted: true } : {}) },
      requiredScopes: params.requiredScopes,
    })
  })
}

/**
 * The scopes a compaction summary must carry: every READ scope any summarised
 * message requires. Compaction neither deletes nor hides the originals (the
 * agent's context merely starts at the latest summary), so the summary is an
 * extra copy of them; requiring the union means only a viewer who could read
 * every original's data can read it. No disclosure list is copied, so it is
 * never wider than any original's classification.
 *
 * The union is PROJECTED onto read scopes (scope-taint.ts, rule 5): a write or
 * action scope on an older stamp classifies no data, and inheriting it made
 * every summary, and every turn that reads it, carry it for good.
 */
export function summaryRequiredScopes(
  summarised: Array<{ requiredScopes: string[] }>,
  orgId?: string,
): string[] {
  return projectTaintScopesForOrg(
    summarised.flatMap((m) => m.requiredScopes),
    orgId,
  )
}

/**
 * The model half of a memory flush, replaced in tests. The flush is otherwise
 * unreachable without a funded provider key, and what the fix is about is where
 * its writes LAND, not what the model chooses to write. Guarded like every
 * other seam in this tree: production can never install one.
 */
export type MemoryFlushGenerate = (params: {
  messages: AgentMessage[]
  writeFile: (path: string, body: string) => Promise<void>
  readFile: (path: string) => Promise<string>
}) => Promise<void>

let memoryFlushGenerateOverride: MemoryFlushGenerate | null = null

/**
 * The memory flush: a silent agentic turn with ONLY the memory verbs
 * available, prompted to persist durable facts from the region about to be
 * summarized away. Skipped for a tainted thread (an injection that survived to
 * the threshold would otherwise persist a durable cross conversation memory)
 * and skipped, never shrunk then sent, when the region is already over the
 * model's input budget.
 *
 * It exposes the memory FILE verbs rather than the legacy single tool, so a
 * flush writes real files in the tree. Scopes are the union of what the region
 * required, stamped explicitly: the flush runs outside a turn frame, so there
 * is no turn taint to read them from.
 *
 * Returns whether the flush actually ran, which is what the caller records on
 * the checkpoint version (one flush per version).
 */
export async function runMemoryFlush(params: {
  orgId: string
  /**
   * A human when the agent has one, a SYSTEM actor for a role or system agent,
   * which has no owning human at all. The actor is who the write runs as; whose
   * tree it lands in is `ownerAgentId`, and the two are no longer the same
   * question.
   */
  actor: ActorContext
  model: unknown
  tainted: boolean
  messages: AgentMessage[]
  inputBudgetTokens: number
  requiredScopes: string[]
  /** The agent whose tree this flush writes. Absent keys on the actor, as before. */
  ownerAgentId?: string
  /** That agent's owning human, for rows written before the rekey. */
  ownerLegacyUserId?: string | null
  /**
   * The pre check this flush runs on, when it has one of its own. A demo
   * visitor's flush runs ONLY with one: each of its requests is a step of
   * that call's meter (settled at what it cost, the next reserved before it
   * is sent), and the flush is recorded as the org's usage. The caller still
   * closes the meter (`finish`) on every path, so a flush that sent nothing
   * gives its hold back.
   */
  // Required, so a caller cannot leave the flush unmetered by omission: a
  // flush once ran with none and spent on the instance's key unbilled.
  credit: {
    model: Parameters<typeof finalizeUsage>[1]["model"]
    keySource: "liaison" | "byok"
    demo?: DemoStepMeter
  }
}): Promise<boolean> {
  const { orgId, actor, tainted, messages: coreMessages, inputBudgetTokens } = params
  if (tainted) return false
  // Not for the reserved App Review demo org: its daily token ceiling would
  // not see this call. A visitor org flushes only on a meter of its own: run
  // under another call's reservation (the summary's in `runCompaction`), its
  // up to five requests would be settled as that one call.
  const { demoOrgKind } = await import("~/modules/demo/demo-spend")
  const kind = await demoOrgKind(orgId)
  if (kind === "reserved") return false
  if (kind === "visitor" && !params.credit.demo) return false
  const meter = params.credit.demo
  // A system actor has no user id; the memory context still needs the field, and
  // an empty one is the fail-closed viewer (it matches no disclosure list).
  const actorUserId = actor.actorType === "user" ? actor.userId : ""
  const ownership = params.ownerAgentId
    ? { ownerAgentId: params.ownerAgentId, ownerLegacyUserId: params.ownerLegacyUserId ?? null }
    : {}
  const flushSize = estimateTokens(serializeMessages(coreMessages))
  if (flushSize > inputBudgetTokens) {
    log.warn(
      { orgId, estimatedTokens: flushSize, inputBudgetTokens },
      "Memory flush input exceeds the model budget, skipping the flush for this advance",
    )
    return false
  }
  const requiredScopes = params.requiredScopes
  const writeFile = async (path: string, body: string) => {
    const parsed = fileToRow(path, body)
    const [type, file] = path.split("/")
    const name = (file ?? "").replace(/\.md$/, "")
    await withRlsContext(actor, async (tx) => {
      await handleMemorySet(
        {
          type,
          name,
          description: (parsed.description || name).slice(0, 160),
          content: parsed.content,
        },
        { userId: actorUserId, orgId, db: tx, ...ownership },
        requiredScopes,
      )
    })
  }
  const readFile = async (path: string): Promise<string> => {
    const [type, file] = path.split("/")
    const name = (file ?? "").replace(/\.md$/, "")
    return await withRlsContext(actor, async (tx) => {
      const row = await handleMemoryGet(
        { type, name },
        { userId: actorUserId, orgId, db: tx, ...ownership },
      )
      return "content" in row ? row.content : ""
    })
  }
  const runner = memoryFlushGenerateOverride
  if (runner) {
    await runner({ messages: coreMessages, writeFile, readFile })
    return true
  }
  // A metered flush stops between steps when the meter refuses the next one
  // (a budget, the step limit), as a turn does.
  const abort = new AbortController()
  let reportedCostUsd: number | null | undefined
  try {
    const result = await generateText({
      // biome-ignore lint/suspicious/noExplicitAny: the model instance is opaque here
      model: params.model as any,
      ...(meter ? { abortSignal: abort.signal } : {}),
      // Every step's reported cost is summed, so a metered flush is billed at
      // what the provider charged for all of its steps.
      onStepFinish: async (step: { usage?: unknown; providerMetadata?: unknown }) => {
        reportedCostUsd = addProviderCostUsd(reportedCostUsd, step.providerMetadata)
        if (!meter) return
        const next = await meter.stepFinished(step.usage, step.providerMetadata)
        if (next.exhausted) abort.abort("demo_budget")
      },
      system:
        "You are the agent's memory keeper. This conversation is about to be summarized. Persist only what the user asked you to remember and lasting corrections or preferences about how you should work, as Markdown files under your memory tree, using memory_create for a new file and memory_str_replace to correct an existing one. Never write task state, secrets, or data an app already holds (contacts, addresses, orders, prices). When there is nothing like that, write nothing.",
      messages: [
        ...(coreMessages as any),
        {
          role: "user" as const,
          content:
            "Before this conversation is summarized, persist what the user asked you to remember and their lasting corrections or preferences, as memory files. Write it once, in your own words, with the date. If there is none, do nothing.",
        },
      ],
      tools: {
        memory_create: tool({
          description: "Create a new memory file at <type>/<slug>.md",
          inputSchema: z.object({
            path: z.string().min(3).max(200),
            body: z.string().min(1).max(8192),
          }),
          execute: async (args) => {
            await writeFile(args.path, args.body)
            return { created: true, path: args.path }
          },
        }),
        memory_str_replace: tool({
          description: "Replace one exact string inside an existing memory file",
          inputSchema: z.object({
            path: z.string().min(3).max(200),
            old: z.string().min(1),
            new: z.string(),
          }),
          execute: async (args) => {
            const content = await readFile(args.path)
            if (!content.includes(args.old)) {
              return { replaced: false, reason: "the text to replace was not found" }
            }
            await writeFile(args.path, content.replace(args.old, args.new))
            return { replaced: true, path: args.path }
          },
        }),
      },
      stopWhen: isStepCount(5),
    })
    // The org's usage (a billed row on a managed cell, a visitor's meter
    // closed at what the steps cost: the hold reserved after the last step
    // was never sent is released). Every step's reported cost is summed.
    await meterSideCall(orgId, params.credit, result.totalUsage, undefined, {
      userId: actorUserId || null,
      ...(typeof reportedCostUsd === "number" ? { providerCostUsd: reportedCostUsd } : {}),
    })
  } catch (err) {
    log.warn({ err }, "Memory flush failed, continuing with the advance")
  }
  return true
}

export async function runCompaction(params: {
  threadId: string
  orgId: string
  actor: UserContext
  lastInputTokens: number
  contextWindow: number
  /**
   * The acting agent. Present means this is an AGENT turn, which no longer
   * writes a thread wide `compaction_summary` message row: it advances that
   * agent's own checkpoint instead (spec-memory.md L4, invariant I5).
   */
  agentId?: string
}): Promise<{ compacted: boolean; fallbackMessages?: AgentMessage[] }> {
  const { threadId, orgId, actor, lastInputTokens, contextWindow, agentId } = params

  if (!shouldCompact(lastInputTokens, contextWindow)) {
    return { compacted: false }
  }

  if (compactingThreads.has(threadId)) {
    return { compacted: false }
  }
  compactingThreads.add(threadId)
  // A visitor demo org's summary runs on a step reservation; whatever path
  // leaves below, the hold is settled or given back (idempotent).
  let demoMeter: { finish: () => Promise<void> } | undefined

  try {
    const cheapModel = await selectSideCallModelForOrg(orgId, "compact-auto-model")
    if (!cheapModel) {
      log.warn({ orgId }, "No auto-eligible model for compaction — skipping")
      return { compacted: false }
    }

    const creditCheck = await preCheck(orgId, cheapModel.modelId)
    if (!creditCheck.allowed) {
      log.warn({ orgId }, "Insufficient credits for compaction — skipping")
      return { compacted: false }
    }
    demoMeter = creditCheck.demo

    const model = await resolveSideCallModel(creditCheck, { threadId })

    const historyMessages = await withRlsContext(actor, async (tx) => {
      return tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.threadId, threadId),
            eq(messages.orgId, orgId),
            isNull(messages.deletedAt),
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messages.id))
    })

    if (historyMessages.length < 4) {
      return { compacted: false }
    }

    // WHOSE TRANSCRIPT IS BEING SUMMARIZED. Without the acting agent's id every
    // agent row converts to an unattributed assistant turn, so a colleague's
    // answers went into the summary as things THIS agent had said, and the
    // mix up outlived the raw tail: it is baked into a checkpoint that every
    // later turn of the thread carries.
    const coreMessages = convertToCoreMessages(historyMessages, undefined, {
      ...(agentId ? { selfAgentId: agentId } : {}),
      ...(agentId ? { agentLabels: await labelsForRegion(orgId, historyMessages, agentId) } : {}),
    })

    // A tainted thread may carry untrusted web/MCP content in its history. The
    // memory flush runs a real write tool (memory_create) over that history
    // outside the executeTool taint gate, so an injection that survives to the
    // compaction threshold could persist a durable cross-conversation memory.
    // Skip the flush entirely for tainted threads — summarisation (read-only)
    // still proceeds.
    const [thread] = await withRlsContext(actor, async (tx) =>
      tx
        .select({ tainted: threads.tainted, taintClearedAt: threads.taintClearedAt })
        .from(threads)
        .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
        .limit(1),
    )
    // The history itself says so too: a summary or a tool result of outside text in it, unless a
    // person cleared it since (replayed-outside-text.ts).
    const tainted =
      (thread?.tainted ?? false) ||
      (await replaysOutsideText(historyMessages, orgId, {
        clearedAt: thread?.taintClearedAt ?? null,
      }))

    // Hard input budget for BOTH LLM calls this function makes (memory flush +
    // summarize): at most half of the COMPACTION model's own context window —
    // the model `model` above actually runs on, via `creditCheck.model`. A
    // thread whose full history exceeds this makes the call itself throw, and
    // since compaction re-runs on every subsequent turn, an uncapped prompt
    // would permanently brick the thread (BL: >1,048,576 tokens on
    // gemini-flash-lite in production).
    const inputBudgetTokens = Math.floor(
      creditCheck.model.contextWindow * COMPACTION_INPUT_BUDGET_FRACTION,
    )

    // An AGENT turn takes the checkpoint route: the flush runs inside the
    // advance, the summary becomes a version row, and NO message row is
    // written. The reactive 80 percent trigger is the last line of defence for
    // a single turn whose tool results blew the budget, so the advance is
    // forced rather than waiting for the stored tail to pass the budget.
    if (agentId) {
      const { advanceCheckpoint } = await import("~/modules/agent/context/checkpoint")
      const advanced = await advanceCheckpoint({
        agentId,
        threadId,
        orgId,
        actor,
        contextWindow,
        force: true,
      })
      return { compacted: advanced.advanced }
    }

    // Step 1: Memory flush, once per checkpoint version (P4m-T17).
    // Metered on the summary's pre check (no demo meter: a visitor's flush
    // needs one of its own, and does not run here).
    await runMemoryFlush({
      orgId,
      actor,
      model,
      tainted,
      messages: coreMessages,
      inputBudgetTokens,
      requiredScopes: summaryRequiredScopes(historyMessages, orgId),
      credit: { model: creditCheck.model, keySource: creditCheck.keySource },
    })

    // Step 2: Prune messages
    const prunedMessages = pruneMessages(coreMessages)

    // Step 3: Summarize. Enforce the same hard budget: if the pruned history
    // is still over it, shrink deterministically (aggressivePrune, then
    // head-drop the oldest remaining messages with a truncation marker) so the
    // summarize call NEVER sends an over-budget prompt — this is the guard
    // that prevents the summarize call itself from throwing on an oversized
    // thread and re-bricking it on every subsequent turn.
    const { messages: summarizeInputMessages, truncated: summarizeTruncated } = fitMessagesToBudget(
      prunedMessages,
      inputBudgetTokens,
    )
    if (summarizeTruncated) {
      log.warn(
        { orgId, threadId, inputBudgetTokens },
        "Summarize input exceeded compaction model budget — truncated deterministically",
      )
    }

    let summary: string
    try {
      const summaryResult = await generateText({
        model,
        system:
          "You are a conversation summarizer. Provide a detailed but concise summary focusing on: what was discussed, actions taken, entities and people involved, the user's current goal, and what needs to happen next.",
        messages: [
          {
            role: "user" as const,
            content:
              "Summarize the following conversation:\n\n" +
              serializeMessages(summarizeInputMessages),
          },
        ],
      })
      summary = summaryResult.text

      await finalizeUsage(orgId, {
        model: creditCheck.model,
        ...sideCallUsage(summaryResult.usage, summaryResult.providerMetadata),
        keySource: creditCheck.keySource,
        userId: actor.userId,
        ...(creditCheck.demo ? { demo: creditCheck.demo } : {}),
      })
    } catch (err) {
      log.error(
        { err },
        "Summarization failed — falling back to aggressive pruning for this request",
      )
      return { compacted: false, fallbackMessages: aggressivePrune(coreMessages) }
    }

    // Step 4: Persist. An AGENT turn writes a checkpoint version, never a
    // message row: the row is shared by every reader of the thread, so the
    // moment one agent compacted, the other agents' rendered history was
    // re-sliced under them and their cached prefixes were gone (I5).
    await persistCompactionSummary({
      threadId,
      orgId,
      userId: actor.userId,
      summary,
      requiredScopes: summaryRequiredScopes(historyMessages, orgId),
      tainted,
    })

    return { compacted: true }
  } finally {
    await demoMeter?.finish()
    compactingThreads.delete(threadId)
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const CompactionTestAccess = {
  /** Swap the model-backed memory flush; pass nothing to restore the real one. */
  setMemoryFlushGenerate(fn?: MemoryFlushGenerate): void {
    if (!isTestEnv()) {
      throw new Error("CompactionTestAccess.setMemoryFlushGenerate is only available in tests")
    }
    memoryFlushGenerateOverride = fn ?? null
  },
}
