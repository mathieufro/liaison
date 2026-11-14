// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Checkpoints and the bounded history load (spec-memory.md L4).
//
// A thread that outgrows the context window is not re-summarized into a
// message row every reader shares. Each agent keeps its OWN rolling summary of
// its OWN view of the thread (`kernel.agent_thread_checkpoints`), and a turn
// loads that summary as one system authored message followed by the raw
// messages after `uptoMessageId`.
//
// WHY THE TAIL IS NEVER TRIMMED PER TURN. The budget below decides WHEN a
// checkpoint advances, never what a single turn renders. Trimming the oldest
// raw messages per turn would move the start of the rendered history on every
// turn, which is a full prompt cache miss every turn: the exact cost invariant
// I3 exists to avoid. So the load returns everything after the current
// checkpoint and reports `overBudget`; the advance runs BETWEEN turns and is
// the one planned prefix rebuild.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { and, asc, desc, sql as drizzleSql, eq, isNull, or } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { agents, agentThreadCheckpoints, messages, threadParticipants } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { env, isTestEnv } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import {
  externalClientLabel,
  foreignAgentLine,
  foreignAuthorOf,
  labelsForRegion,
  UNKNOWN_AGENT_LABEL,
} from "~/modules/agent/context/agent-attribution"
import type { BriefRowInput } from "~/modules/agent/context/brief-store"
import {
  advanceMark,
  recentEpisodeTitles,
  regionPastMark,
  renderCore,
  upsertBriefRows,
  upsertEpisode,
} from "~/modules/agent/context/brief-store"
import {
  BRIEF_CORE_TOKEN_BUDGET,
  BRIEF_EPISODE_TOKEN_BUDGET,
  isRetrievalTool,
} from "~/modules/agent/context/cold-resume"
import {
  COMPACTION_INPUT_BUDGET_FRACTION,
  estimateTokens,
  fitMessagesToBudget,
  summaryRequiredScopes,
} from "~/modules/agent/context/compaction"
import { readGuideNotes } from "~/modules/agent/context/guide-notes"
import { orgHistoryBudgetCap } from "~/modules/agent/context/history-settings"
import {
  meterSideCall,
  preCheck,
  selectSideCallModelForOrg,
} from "~/modules/agent/credits/credit-meter"
import { resolveSideCallModel } from "~/modules/agent/providers/side-call-model"
import { truncateReplayedToolResult } from "~/modules/agent/runtime/result-truncation"
import { clearedByPerson, replaysOutsideText } from "~/modules/agent/scopes/replayed-outside-text"
import { loadTaintClearedAt } from "~/modules/agent/scopes/taint"
import { writeAuditLog } from "~/modules/audit/service"
import { isMessageVisible } from "~/services/security/visibility"

const log = rootLogger.child({ module: "checkpoint" })

/**
 * The raw history budget, in tokens, when nothing else is set: the instance
 * default (`AGENT_HISTORY_BUDGET_TOKENS`, 256,000 unless set) is what an org's
 * own setting (`historyBudgetTokens`) overrides.
 *
 * LARGE ON PURPOSE. A provider caches a request as far as it repeats the one
 * before, and a cached input token costs a fraction of a fresh one. Every
 * checkpoint advance rewrites the prefix, so the turn after it pays for the
 * whole history uncached. A small budget advanced every few turns and paid
 * that again and again; carrying a large, cached history is cheaper than
 * re-sending a freshly summarized one that often.
 */
export const HISTORY_TAIL_TOKEN_BUDGET = 256_000
/** The smallest budget an org may set: below it a summary does not pay for itself. */
export const HISTORY_BUDGET_MIN_TOKENS = 32_000
/**
 * The share of a small model's window the history may always take. The
 * emergency compaction fires at 80 percent of the window (compaction.ts), so
 * 40 percent leaves the other 40 for the system prompt, the tool schemas and
 * the turn in progress, and the last 20 for the answer.
 */
export const HISTORY_BUDGET_WINDOW_FRACTION = 0.4
/**
 * What a turn needs beside the history, in tokens: system prompt (about
 * 12,000), tool schemas (about 13,000) and the turn's own steps and live tool
 * results. A large window gives the history everything up to the emergency
 * compaction line minus this.
 */
export const HISTORY_NON_HISTORY_RESERVE_TOKENS = 96_000
/** The emergency compaction line, as a share of the window (compaction.ts COMPACTION_THRESHOLD). */
const EMERGENCY_COMPACTION_FRACTION = 0.8

/** The instance default budget: the env setting, or 256,000. */
export function defaultHistoryBudgetCap(): number {
  return env.AGENT_HISTORY_BUDGET_TOKENS ?? HISTORY_TAIL_TOKEN_BUDGET
}

/**
 * The raw history budget for a model: the configured cap (an org's setting,
 * else the instance default, 256,000), clamped only where the model's window
 * cannot hold that much history beside the prompt, the tools, the turn and the
 * answer: to `max(0.4 x window, 0.8 x window - 96,000)`. Every window of
 * 440,000 tokens or more gets the full cap; a 200,000 window gets 80,000.
 *
 * An unknown window falls back to the cap rather than to zero, which would
 * advance a checkpoint on every turn.
 */
export function historyBudget(
  contextWindow: number,
  cap: number = defaultHistoryBudgetCap(),
): number {
  const ceiling = Math.max(HISTORY_BUDGET_MIN_TOKENS, Math.floor(cap))
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return ceiling
  const fit = Math.max(
    HISTORY_BUDGET_WINDOW_FRACTION * contextWindow,
    EMERGENCY_COMPACTION_FRACTION * contextWindow - HISTORY_NON_HISTORY_RESERVE_TOKENS,
  )
  return Math.min(ceiling, Math.floor(fit))
}

export interface CheckpointRow {
  id: string
  version: number
  summary: string
  uptoMessageId: string | null
  requiredScopes: string[]
  tokenEstimate: number
  createdAt: Date
  staleAt: Date | null
  /** The summarised region carried outside text (scopes/replayed-outside-text.ts). */
  tainted: boolean
}

/**
 * The current (highest) checkpoint version of one thread FOR ONE AGENT. Keyed
 * by `(agentId, threadId)` and nothing else: agent A's checkpoint is invisible
 * to agent B (invariant I5), and the RLS policy underneath refuses it anyway.
 */
export async function loadCurrentCheckpoint(params: {
  agentId: string
  threadId: string
  orgId: string
  actor: UserContext
}): Promise<CheckpointRow | null> {
  const { agentId, threadId, orgId, actor } = params
  const rows = await withRlsContext(actor, async (tx) =>
    tx
      .select({
        id: agentThreadCheckpoints.id,
        version: agentThreadCheckpoints.version,
        summary: agentThreadCheckpoints.summary,
        uptoMessageId: agentThreadCheckpoints.uptoMessageId,
        requiredScopes: agentThreadCheckpoints.requiredScopes,
        tokenEstimate: agentThreadCheckpoints.tokenEstimate,
        createdAt: agentThreadCheckpoints.createdAt,
        staleAt: agentThreadCheckpoints.staleAt,
        tainted: agentThreadCheckpoints.tainted,
      })
      .from(agentThreadCheckpoints)
      .where(
        and(
          eq(agentThreadCheckpoints.orgId, orgId),
          eq(agentThreadCheckpoints.agentId, agentId),
          eq(agentThreadCheckpoints.threadId, threadId),
        ),
      )
      .orderBy(desc(agentThreadCheckpoints.version))
      .limit(1),
  )
  return rows[0] ?? null
}

/**
 * The core FROZEN on one checkpoint version (P4c-T49), or null when that
 * version predates the column or its render failed.
 *
 * Read with raw SQL rather than through the table's Drizzle definition: the
 * column belongs to the brief slice, and the checkpoint row's own definition
 * stays the four immutable columns its trigger guards plus the two flags.
 */
export async function loadFrozenCore(params: {
  orgId: string
  checkpointId: string
}): Promise<string | null> {
  const result = await withPrivilegedDb(params.orgId, "checkpoint-core-read", (tx) =>
    tx.execute(
      drizzleSql`SELECT core_brief FROM ${drizzleSql.raw(schemaRef("kernel"))}.agent_thread_checkpoints
                 WHERE id = ${params.checkpointId} AND org_id = ${params.orgId} LIMIT 1`,
    ),
  )
  const found = ((result as { rows?: Record<string, unknown>[] }).rows ??
    (result as Record<string, unknown>[])) as Array<{ core_brief: string | null }>
  return found[0]?.core_brief ?? null
}

/** One stored message row, as the history load hands it on. */
export type HistoryMessageRow = typeof messages.$inferSelect

export interface BoundedHistory {
  /**
   * The checkpoint this turn RENDERS, or null when this agent has none for the
   * thread or the one it has is stale.
   */
  checkpoint: CheckpointRow | null
  /**
   * The stale checkpoint that was NOT rendered, when there is one. It carries
   * the version number the next advance counts from, and nothing else: its
   * summary quotes a message a human deleted, so it never reaches a prompt and
   * is never folded into the next summary.
   */
  staleCheckpoint: CheckpointRow | null
  /** The raw messages after the checkpoint, in thread order. */
  messages: HistoryMessageRow[]
  /** `chars / 4` over the raw tail only, the same estimator compaction uses. */
  estimatedTokens: number
  /** The tail is past the budget: the caller should advance BETWEEN turns. */
  overBudget: boolean
  /** The budget this load measured against. */
  budgetTokens: number
  /**
   * Ids in the raw tail that RLS returned but the TURN's viewer may not read.
   * A message the previous turn rendered and this one may not is a revoke, and
   * a revoke forces a rebuild: security wins over cache (I4).
   */
  hiddenMessageIds: string[]
}

/** The legacy thread wide compaction summary row, if one is still in the tail. */
function sliceAtLegacyCompactionSummary(rows: HistoryMessageRow[]): HistoryMessageRow[] {
  for (let i = rows.length - 1; i >= 0; i--) {
    const meta = rows[i].metadata as { type?: string } | null
    if (meta?.type === "compaction_summary") return rows.slice(i)
  }
  return rows
}

/**
 * The thread's history for one turn: the raw messages after this agent's
 * current checkpoint, plus that checkpoint.
 *
 * The legacy thread wide `compaction_summary` row is still honoured, applied
 * to the raw tail only. It is written by nothing in this release (the agent
 * path writes checkpoints instead) and the scan goes away one release after
 * this one, once no live thread carries such a row any more.
 */
/**
 * What ONE stored row costs the model when the history is replayed, counted on
 * what `convertToCoreMessages` (context.ts) actually renders for it:
 *
 * - its text;
 * - each tool call: name, arguments, and the provider state replayed with it
 *   (`providerMetadata`: Gemini's thought signature, OpenRouter's
 *   `reasoning_details`, i.e. the reasoning of that step, sent back as is);
 * - each tool result, clipped as the replay clips it;
 * - the guide notes the turn was sent (`metadata.guideNotes`: app guides, tool
 *   schemas, skills), which replay as user messages at the place they were sent.
 *
 * Counting text and results alone measured a third of a long thread's real
 * history (22,000 against 73,000 tokens in one): the budget never fired.
 */
export function historyRowTokens(row: { content?: string | null; metadata?: unknown }): number {
  let text = row.content ?? ""
  const meta = row.metadata as {
    toolCalls?: Array<Record<string, unknown>>
  } | null
  const calls = meta?.toolCalls
  if (Array.isArray(calls)) {
    for (const call of calls) {
      text += `\n${String(call.toolName ?? "")}\n${JSON.stringify(call.args ?? null)}`
      if (call.providerMetadata) text += `\n${JSON.stringify(call.providerMetadata)}`
      const replayed = truncateReplayedToolResult((call.result as unknown) ?? null)
      text += `\n${typeof replayed === "string" ? replayed : JSON.stringify(replayed)}`
    }
  }
  for (const note of readGuideNotes(row.metadata)) text += `\n${note.content}`
  return estimateTokens(text)
}

export async function loadBoundedHistory(params: {
  threadId: string
  orgId: string
  actor: UserContext
  agentId?: string
  contextWindow?: number
  /** The turn's own floor, which RLS knows nothing about. */
  viewer?: { userId: string; grants: string[] }
  /**
   * A REPLY-THREAD turn (A8): the history is this root and its replies, in
   * thread order, and nothing else. The channel's checkpoint is not read (it
   * summarizes the channel, not this thread) and the channel's join point
   * does not cut it (S8: the root is the question's context, whenever the
   * agent was seated). Absent: the CHANNEL's history, which leaves out every
   * reply the channel does not show.
   */
  replyRootId?: string
}): Promise<BoundedHistory> {
  const { threadId, orgId, actor, agentId, replyRootId } = params
  // THE ORG'S CAP (Settings > AI models), else the instance default, clamped
  // to what this model's window holds.
  const budgetTokens = historyBudget(params.contextWindow ?? 0, await orgHistoryBudgetCap(orgId))

  if (replyRootId) {
    const rows = await withRlsContext(actor, async (tx) =>
      tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.threadId, threadId),
            eq(messages.orgId, orgId),
            isNull(messages.deletedAt),
            or(eq(messages.id, replyRootId), eq(messages.replyRootId, replyRootId)),
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messages.id)),
    )
    const estimatedTokens = rows.reduce((sum, m) => sum + historyRowTokens(m), 0)
    const viewer = params.viewer
    return {
      checkpoint: null,
      staleCheckpoint: null,
      messages: rows,
      estimatedTokens,
      overBudget: estimatedTokens > budgetTokens,
      budgetTokens,
      hiddenMessageIds: viewer
        ? rows
            .filter(
              (m) =>
                !isMessageVisible(
                  {
                    requiredScopes: m.requiredScopes ?? [],
                    disclosureList: m.disclosureList ?? null,
                  },
                  viewer,
                ),
            )
            .map((m) => m.id)
        : [],
    }
  }

  const current = agentId ? await loadCurrentCheckpoint({ agentId, threadId, orgId, actor }) : null
  // A STALE CHECKPOINT IS NOT RENDERED (spec-memory.md "Deletion"). It was
  // built from a message a human has since deleted, and consolidation only
  // rebuilds stale EPISODES, so rendering it would carry the deleted text into
  // every later turn's prompt for the life of the thread. The raw tail is
  // rendered whole instead; the next advance writes a clean version from the
  // surviving rows and clears the flag. The cost is one prefix rebuild, which
  // is exactly the trade I4 already makes for a revoke.
  const stale = current?.staleAt != null
  const checkpoint = stale ? null : current

  const rows = await withRlsContext(actor, async (tx) =>
    tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          eq(messages.orgId, orgId),
          isNull(messages.deletedAt),
          // A8: the channel's raw tail is the CHANNEL view. A reply the
          // channel does not show belongs to its reply thread's turns.
          or(isNull(messages.replyRootId), eq(messages.alsoInChannel, true)),
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messages.id)),
  )

  let tail = rows
  // PER AGENT TAIL (invariant I5): nothing before this agent's own join point
  // ever enters its rendered history, so two agents in one room render two
  // different conversations from the same stored rows.
  if (agentId) {
    const seated = await agentSeatedInThread({ agentId, threadId, orgId })
    if (seated) {
      const joinPoint = await agentJoinPoint({ agentId, threadId, orgId })
      // Seated with nothing at or after the seat means an EMPTY tail, which is
      // not the same answer as having no seat at all (a DM, where the whole
      // thread is the agent's). `rows` is already in (created_at, id) order, so
      // slicing at the anchor applies exactly the order the list is built on.
      const idx = joinPoint ? tail.findIndex((m) => m.id === joinPoint.id) : -1
      tail = joinPoint && idx >= 0 ? tail.slice(idx) : []
    }
  }
  if (checkpoint?.uptoMessageId) {
    const idx = tail.findIndex((m) => m.id === checkpoint.uptoMessageId)
    // An unknown `uptoMessageId` (the message was deleted) leaves the whole
    // thread raw rather than dropping it: the checkpoint is stale and the next
    // consolidation rebuilds it. Losing a summary is recoverable; rendering a
    // summary whose boundary is unknown would silently drop real turns.
    if (idx >= 0) tail = tail.slice(idx + 1)
  }
  tail = sliceAtLegacyCompactionSummary(tail)

  // MEASURED AS THE MODEL RECEIVES IT. `estimateTokens(content)` counted the
  // text of a row and nothing else, while an agent row replays its stored tool
  // calls and their results too (`convertToCoreMessages`), each result up to
  // REPLAY_RESULT_LIMITS. A tail of a dozen tool calls therefore measured near
  // zero and rode over the budget unseen, which is why `overBudget` never
  // fired on the turns that shipped six figures of input tokens.
  //
  // The tail is NOT trimmed here: `advanceCheckpoint` loads through this same
  // function and has to see the whole region it is about to summarize. The
  // ASSEMBLY path trims, through `trimHistoryToBudget` (A50).
  const estimatedTokens = tail.reduce((sum, m) => sum + historyRowTokens(m), 0)
  const hiddenMessageIds = params.viewer
    ? tail
        .filter(
          (m) =>
            !isMessageVisible(
              {
                requiredScopes: m.requiredScopes ?? [],
                disclosureList: m.disclosureList ?? null,
              },
              params.viewer as { userId: string; grants: string[] },
            ),
        )
        .map((m) => m.id)
    : []
  return {
    checkpoint,
    staleCheckpoint: stale ? current : null,
    messages: tail,
    estimatedTokens,
    overBudget: estimatedTokens > budgetTokens,
    budgetTokens,
    hiddenMessageIds,
  }
}

/**
 * THE RAW TAIL CAP, APPLIED TO THE TURN BEING ASSEMBLED (A50, spec-memory.md
 * "Budgets").
 *
 * `overBudget` used to be advisory: it steered the BETWEEN-turns checkpoint
 * advance, so the turn that first went over the budget shipped the whole raw
 * tail to the provider, and so did every turn until an advance landed. The cap
 * is enforced on the prompt, here, and the advance still does its own work on
 * the untrimmed tail afterwards.
 *
 * Whole rows are dropped from the OLDEST end, never half a row and never the
 * last one: a tail of one oversized message is still that message, and cutting
 * it in half would hand the model a truncated question.
 */
export function trimHistoryToBudget<
  T extends { id: string; content?: string | null; metadata?: unknown },
>(
  rows: T[],
  budgetTokens: number,
): { rows: T[]; droppedRows: number; rawTokens: number; keptTokens: number } {
  const cost = rows.map((r) => historyRowTokens(r))
  const rawTokens = cost.reduce((a, b) => a + b, 0)
  if (rawTokens <= budgetTokens) return { rows, droppedRows: 0, rawTokens, keptTokens: rawTokens }
  let from = 0
  let running = rawTokens
  while (from < rows.length - 1 && running > budgetTokens) {
    running -= cost[from]
    from++
  }
  return { rows: rows.slice(from), droppedRows: from, rawTokens, keptTokens: running }
}

/** The system row type carrying the guide notes of history rows the raw tail cap dropped. */
export const CARRIED_GUIDE_NOTES_TYPE = "carried_guide_notes"

/**
 * The guide notes of the rows the raw tail cap dropped (trimHistoryToBudget), as one history row
 * placed ahead of the kept tail, or null when they carried none. Without it a guide whose note
 * sat in a dropped row left the history and was sent again as a new note the next turn, and again
 * each time the window slid: on a long thread the same guides were sent turn after turn. A
 * checkpoint's fold is different: what it folds is summarised and its guides are sent again once.
 * NOT a `messages` row and never persisted.
 */
export function carriedGuideNotesRow(
  dropped: ReadonlyArray<{ metadata?: unknown; createdAt?: unknown }>,
  kept: ReadonlyArray<{ metadata?: unknown }>,
  params: { threadId: string; orgId: string },
): HistoryMessageRow | null {
  // A note the kept tail replays itself is not carried twice.
  const seen = new Set<string>(
    kept.flatMap((row) => readGuideNotes(row.metadata).map((n) => n.content)),
  )
  const notes: Array<{ afterToolCallId: null; content: string }> = []
  for (const row of dropped) {
    for (const note of readGuideNotes(row.metadata)) {
      if (seen.has(note.content)) continue
      seen.add(note.content)
      notes.push({ afterToolCallId: null, content: note.content })
    }
  }
  if (notes.length === 0) return null
  const at = dropped[dropped.length - 1]?.createdAt ?? null
  return {
    id: `carried-guide-notes:${params.threadId}`,
    threadId: params.threadId,
    orgId: params.orgId,
    authorId: null,
    authorType: "system",
    authorAgentId: null,
    content: "",
    metadata: { type: CARRIED_GUIDE_NOTES_TYPE, guideNotes: notes },
    requiredScopes: [],
    disclosureList: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  } as unknown as HistoryMessageRow
}

/**
 * The checkpoint summary as a history message row, so the renderer treats it
 * exactly like any other stored row (one pure function of the stored state,
 * invariant I1). It is NOT a `messages` row and is never persisted.
 */
export function checkpointAsHistoryRow(
  checkpoint: CheckpointRow,
  params: { threadId: string; orgId: string },
): HistoryMessageRow {
  return {
    id: checkpoint.id,
    threadId: params.threadId,
    orgId: params.orgId,
    authorId: null,
    authorType: "system",
    authorAgentId: null,
    content: checkpoint.summary,
    metadata: {
      type: "checkpoint_summary",
      version: checkpoint.version,
      ...(checkpoint.tainted ? { tainted: true } : {}),
    },
    requiredScopes: checkpoint.requiredScopes,
    disclosureList: null,
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.createdAt,
    deletedAt: null,
  } as unknown as HistoryMessageRow
}

// --- The advance (P4m-T16) -------------------------------------------------

/**
 * HYSTERESIS: the share of the budget an advance leaves raw. An advance is the
 * one planned prefix rebuild (I3): the turn after it pays for its whole input
 * uncached, every turn after that reads it from the cache. Folding the tail
 * down to HALF the budget puts the next advance half a budget of new raw
 * history away (128,000 tokens at the default budget, dozens of turns), so
 * one advance is one cache reset followed by a long run of cached turns, and
 * a thread never advances turn after turn.
 */
export const CHECKPOINT_TAIL_FRACTION = 0.5

/** Raw tokens an advance leaves in the tail for a given budget: half of it. */
export function checkpointRawTailReserve(budgetTokens: number): number {
  return Math.floor(budgetTokens * CHECKPOINT_TAIL_FRACTION)
}

/** What the brief writer is handed: the prompt, the previous brief, the new region. */
export interface CheckpointSummarizerInput {
  orgId: string
  /** The thread the brief is for: an OpenRouter call stays on its upstream host. */
  threadId?: string
  actor: UserContext
  /**
   * The compaction brief prompt, verbatim from
   * `prompts/compaction-brief.md` (P4c-T24). The writer's whole instruction:
   * the five sections, the message id rule, "was X until <date>, now Y", and
   * omit if unsure.
   */
  prompt: string
  /** The brief written so far, which this call rewrites. Null on the first region. */
  previousSummary: string | null
  messages: Array<{ role: string; content: unknown }>
  /** The region's stored rows, in the order of `messages`. */
  regionRows?: HistoryMessageRow[]
  /** The raw rows the advance leaves after the region, oldest first. */
  keptRows?: HistoryMessageRow[]
}

export type CheckpointSummarizer = (input: CheckpointSummarizerInput) => Promise<string | null>

let summarizerOverride: CheckpointSummarizer | undefined

/**
 * The default brief writer: the cheap tier the compaction flush already selects
 * (the org's compaction model), under compaction's own 50 percent input budget.
 * Returns null when no model is available or the call fails, which ABORTS the
 * advance rather than writing a version whose brief lost the region it was
 * supposed to carry.
 *
 * INCREMENTAL BY CONSTRUCTION: the call sees the previous brief plus the new
 * region, never the whole history. The region it is handed is what the caller
 * already narrowed to this agent and already stripped of retrieval tool parts.
 */
async function defaultCheckpointSummarizer(
  input: CheckpointSummarizerInput,
): Promise<string | null> {
  const { generateText } = await import("ai")
  const cheapModel = await selectSideCallModelForOrg(input.orgId, "checkpoint-auto-model")
  if (!cheapModel) {
    log.warn({ orgId: input.orgId }, "No auto-eligible model for a checkpoint advance, skipping")
    return null
  }
  const creditCheck = await preCheck(input.orgId, cheapModel.modelId)
  if (!creditCheck.allowed) {
    log.warn({ orgId: input.orgId }, "Insufficient credits for a checkpoint advance, skipping")
    return null
  }
  // Settled in `finally` from here on, whatever throws: a demo org's hold
  // ends at what the call cost, or released when nothing was sent.
  let usage: { inputTokens?: number; outputTokens?: number } | null = null
  let providerMetadata: unknown
  try {
    const model = await resolveSideCallModel(creditCheck, { threadId: input.threadId ?? null })
    const budgetTokens = Math.floor(
      creditCheck.model.contextWindow * COMPACTION_INPUT_BUDGET_FRACTION,
    )
    const { messages: fitted } = fitMessagesToBudget(input.messages, budgetTokens)
    const serialized = fitted
      .map(
        (m) =>
          `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
      )
      .join("\n\n")
    const result = await generateText({
      model,
      system: input.prompt,
      messages: [
        {
          role: "user" as const,
          content: `## The brief so far\n\n${
            input.previousSummary && input.previousSummary.trim().length > 0
              ? input.previousSummary
              : "(empty, this is the first region)"
          }\n\n## The new region\n\n${serialized}`,
        },
      ],
    })
    usage = result.usage ?? {}
    providerMetadata = result.providerMetadata
    return result.text
  } catch (err) {
    log.error({ err, orgId: input.orgId }, "Checkpoint brief writing failed, advance skipped")
    return null
  } finally {
    await meterSideCall(input.orgId, creditCheck, usage, providerMetadata)
  }
}

// --- The brief (P4c-T24) ---------------------------------------------------

/** The bench's prompt, shipped with the production prompts. */
const BRIEF_PROMPT_FILE = path.resolve(import.meta.dir, "..", "prompts", "compaction-brief.md")

/**
 * The fallback if the file cannot be read. Deliberately thin: it keeps the
 * shape (five sections, ids, both states of a changed value) so a brief written
 * without the file is still parseable, and the real rules stay in one place.
 */
const BRIEF_PROMPT_FALLBACK = `You are the agent's compaction writer. Rewrite the brief so far plus the new region into ONE brief.
Write only these five sections, in this order, with these exact headings: "### Current decisions", "### Open loops", "### Identifiers and entities", "### Standing procedures", "### Unresolved contradictions". An empty section still appears, with the single line "none".
Every line ends with the message ids it came from, in square brackets. A value that changed is one line carrying both states: "was X until <date>, now Y". Omit if unsure, never invent.`

let briefPromptCache: string | null = null

/** The brief writer's prompt, read once. Byte identical to the file on disk. */
export async function loadBriefPrompt(): Promise<string> {
  if (briefPromptCache !== null) return briefPromptCache
  try {
    briefPromptCache = await readFile(BRIEF_PROMPT_FILE, "utf-8")
  } catch (err) {
    log.error({ err, file: BRIEF_PROMPT_FILE }, "Could not read the compaction brief prompt")
    briefPromptCache = BRIEF_PROMPT_FALLBACK
  }
  return briefPromptCache
}

/** The sections that make the CORE: what is true now, and what is still owed. */
export const BRIEF_CORE_SECTIONS = [
  "Current decisions",
  "Open loops",
  "Identifiers and entities",
] as const

/** The sections that make the region's EPISODE: the rest, fetched not fed forward. */
export const BRIEF_EPISODE_SECTIONS = ["Standing procedures", "Unresolved contradictions"] as const

/** The heading the episode titles ride under on a checkpoint summary. */
export const BRIEF_EPISODES_HEADING = "## Episodes"

function briefSectionOf(line: string): string | null {
  const trimmed = line.trim()
  if (!/^#{1,6}\s+/.test(trimmed)) return null
  return trimmed.replace(/^#+\s*/, "").trim()
}

/**
 * Split one brief into the CORE and the region's EPISODE.
 *
 * A brief with no recognisable heading at all (a model that ignored the prompt,
 * or a scripted test summary) is taken as a core in one piece rather than
 * dropped: losing the region would be the worse failure.
 */
export function splitBrief(text: string): { core: string; episode: string } {
  const core: string[] = []
  const episode: string[] = []
  let bucket: "none" | "core" | "episode" = "none"
  for (const line of text.split("\n")) {
    const heading = briefSectionOf(line)
    if (heading !== null) {
      if ((BRIEF_CORE_SECTIONS as readonly string[]).includes(heading)) bucket = "core"
      else if ((BRIEF_EPISODE_SECTIONS as readonly string[]).includes(heading)) bucket = "episode"
      else {
        // Any other heading (a preamble, the prompt's own "## Rules") closes
        // whatever section was open: only the five named ones carry content.
        bucket = "none"
        continue
      }
    }
    if (bucket === "core") core.push(line)
    else if (bucket === "episode") episode.push(line)
  }
  if (core.length === 0 && episode.length === 0) return { core: text.trim(), episode: "" }
  return { core: core.join("\n").trim(), episode: episode.join("\n").trim() }
}

/**
 * Clip text to a token budget ON A LINE BOUNDARY: a half line of a brief is a
 * half fact, and a half fact with a truncated message id cannot be opened.
 */
export function clipToTokenBudget(
  text: string,
  budgetTokens: number,
): { text: string; clipped: boolean } {
  const kept: string[] = []
  let tokens = 0
  for (const line of text.split("\n")) {
    const cost = estimateTokens(`${line}\n`)
    if (tokens + cost > budgetTokens) return { text: kept.join("\n"), clipped: true }
    kept.push(line)
    tokens += cost
  }
  return { text: kept.join("\n"), clipped: false }
}

/** The first decision line of a core, as a title fragment, or "" when there is none. */
export function firstDecisionLine(core: string): string {
  let inDecisions = false
  for (const line of core.split("\n")) {
    const heading = briefSectionOf(line)
    if (heading !== null) {
      inDecisions = heading === "Current decisions"
      continue
    }
    if (!inDecisions) continue
    const text = line.trim().replace(/^[-*]\s*/, "")
    if (text.length === 0 || text.toLowerCase() === "none") continue
    // The ids belong to the line, not to a title.
    return text.replace(/\s*\[[^\]]*\]\s*$/, "").slice(0, 160)
  }
  return ""
}

/** `YYYY-MM-DD`, or `YYYY-MM-DD to YYYY-MM-DD` when the region spans days. */
export function regionDateSpan(region: Array<{ createdAt: Date }>): string {
  const first = region[0]?.createdAt
  const last = region[region.length - 1]?.createdAt
  if (!first || !last) return "undated"
  const from = first.toISOString().slice(0, 10)
  const to = last.toISOString().slice(0, 10)
  return from === to ? from : `${from} to ${to}`
}

/** The region's episode title: its date span, then its first decision. */
export function episodeTitle(params: { region: Array<{ createdAt: Date }>; core: string }): string {
  const span = regionDateSpan(params.region)
  const decision = firstDecisionLine(params.core)
  return decision ? `${span}: ${decision}` : span
}

/** The core plus the thread's episode titles: what the checkpoint row carries. */
export function composeSummary(core: string, episodeTitles: string[]): string {
  if (episodeTitles.length === 0) return core
  const titles = episodeTitles.map((t) => `- ${t}`).join("\n")
  return core.length > 0
    ? `${core}\n\n${BRIEF_EPISODES_HEADING}\n${titles}`
    : `${BRIEF_EPISODES_HEADING}\n${titles}`
}

// --- The brief rows (P4c-T49) ---------------------------------------------

/**
 * Turn one region of conversation into brief LINES. The summarizer's sibling:
 * the summary says roughly what happened, the extractor says what the
 * conversation now holds to be true, one key at a time.
 */
export type BriefRowExtractor = (input: {
  orgId: string
  threadId: string
  agentId: string
  region: HistoryMessageRow[]
}) => Promise<BriefRowInput[]>

let briefRowExtractorOverride: BriefRowExtractor | undefined

const BRIEF_EXTRACTOR_SYSTEM_PROMPT = `You turn a stretch of conversation into BRIEF ROWS.
A row is one fact the conversation now holds: a decision, an open loop (something still owed), an identifier (a number, an address, an account, a name), a procedure (how something is done here), or a contradiction (two things said that cannot both be true).
Answer with JSON only: {"rows":[{"kind":"decision|open_loop|identifier|procedure|contradiction","key":"what the line is about","value":"what it says","messageIds":["..."],"closes":false}]}
The key is the STABLE half ("ship date for order 1042"), the value is what may change. Reuse the exact key of an earlier line when you are updating it, so the update supersedes it instead of sitting beside it.
Set closes to true only when this line answers an open loop already recorded under the same key.
messageIds must be ids taken from the messages you were given, earliest first. Emit nothing you cannot point at a message for.`

/**
 * The default extractor: the same cheap tier the summary uses, asked for rows.
 * Every failure mode (no model, no credits, unparseable answer) returns an
 * EMPTY list rather than throwing: a region with no rows costs the brief those
 * lines, while a throw would cost the advance that was about to land.
 */
async function defaultBriefRowExtractor(input: {
  orgId: string
  threadId: string
  agentId: string
  region: HistoryMessageRow[]
}): Promise<BriefRowInput[]> {
  // Settled into the reserved demo org's ledger in `finally`; a no-op otherwise.
  let settle: Parameters<typeof meterSideCall>[1] | null = null
  let usage: { inputTokens?: number; outputTokens?: number } | null = null
  let providerMetadata: unknown
  try {
    const { generateText } = await import("ai")
    const cheapModel = await selectSideCallModelForOrg(input.orgId, "brief-extract-auto-model")
    if (!cheapModel) return []
    const creditCheck = await preCheck(input.orgId, cheapModel.modelId)
    if (!creditCheck.allowed) return []
    settle = creditCheck
    const model = await resolveSideCallModel(creditCheck, { threadId: input.threadId })
    const budgetTokens = Math.floor(
      creditCheck.model.contextWindow * COMPACTION_INPUT_BUDGET_FRACTION,
    )
    const labels = await labelsForRegion(input.orgId, input.region, input.agentId)
    const { messages: fitted } = fitMessagesToBudget(
      input.region.map((m) => {
        const { role, body } = attributedLine(m, { selfAgentId: input.agentId, labels })
        return { role, content: body }
      }),
      budgetTokens,
    )
    const result = await generateText({
      model,
      system: BRIEF_EXTRACTOR_SYSTEM_PROMPT,
      messages: [
        {
          role: "user" as const,
          content: fitted
            .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : ""}`)
            .join("\n\n"),
        },
      ],
    })
    usage = result.usage ?? {}
    providerMetadata = result.providerMetadata
    return parseBriefRows(result.text, input.region)
  } catch (err) {
    log.error({ err, threadId: input.threadId }, "Brief row extraction failed, rows skipped")
    return []
  } finally {
    if (settle) await meterSideCall(input.orgId, settle, usage, providerMetadata)
  }
}

const BRIEF_KINDS = new Set(["decision", "open_loop", "identifier", "procedure", "contradiction"])

/**
 * The extractor's answer, parsed defensively. Every row is checked against the
 * REGION it was drawn from: a kind that is not one of the five, an empty key or
 * value, or a message id the region does not contain is dropped, because a row
 * nobody can open is a claim with no evidence behind it.
 */
export function parseBriefRows(text: string, region: Array<{ id: string }>): BriefRowInput[] {
  const known = new Set(region.map((m) => m.id))
  const order = new Map(region.map((m, i) => [m.id, i]))
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  const raw = (parsed as { rows?: unknown }).rows
  if (!Array.isArray(raw)) return []
  const out: BriefRowInput[] = []
  for (const candidate of raw) {
    const row = candidate as Record<string, unknown>
    const kind = String(row.kind ?? "")
    const key = String(row.key ?? "").trim()
    const value = String(row.value ?? "").trim()
    if (!BRIEF_KINDS.has(kind) || key.length === 0 || value.length === 0) continue
    const ids = Array.isArray(row.messageIds)
      ? row.messageIds
          .filter((v): v is string => typeof v === "string" && known.has(v))
          .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      : []
    if (ids.length === 0) continue
    out.push({
      kind: kind as BriefRowInput["kind"],
      key,
      value,
      messageIds: ids,
      firstMessageId: ids[0],
      ...(row.closes === true ? { closes: true, closingMessageId: ids[0] } : {}),
    })
  }
  return out
}

/**
 * Extract and persist the brief rows for the part of `region` the thread's mark
 * has not already covered, then move the mark.
 *
 * ONCE PER REGION, WHOEVER GETS THERE FIRST. The rows are facts of the
 * conversation, so a second agent advancing over the same stretch finds the
 * mark past it and writes nothing: two agents in one room do not produce two
 * copies of one decision. Returns the ids written, for search indexing.
 */
async function writeBriefRowsForRegion(params: {
  orgId: string
  threadId: string
  agentId: string
  region: HistoryMessageRow[]
}): Promise<string[]> {
  const { orgId, threadId, agentId } = params
  const extractor = briefRowExtractorOverride ?? defaultBriefRowExtractor
  try {
    const pending = await withPrivilegedDb(orgId, "brief-rows-region", (tx) =>
      regionPastMark(tx, { orgId, threadId, region: params.region }),
    )
    if (pending.length === 0) return []
    // A50: the extractor never sees a retrieval tool part either. A brief row
    // built from a memory_search result is the agent quoting itself back.
    const extracted = await extractor({
      orgId,
      threadId,
      agentId,
      region: stripRetrievalToolParts(pending),
    })
    const regionStart = pending[0].id
    const regionEnd = pending[pending.length - 1].id
    return await withPrivilegedDb(orgId, "brief-rows-write", async (tx) => {
      const ids = await upsertBriefRows(tx, {
        orgId,
        threadId,
        agentId,
        rows: extracted,
        regionStart,
        regionEnd,
      })
      // The mark moves whether or not the region yielded rows: a stretch with
      // nothing worth recording is still a stretch that has been read, and
      // leaving the mark behind would re-extract it on every later advance.
      await advanceMark(tx, { orgId, threadId, uptoMessageId: regionEnd })
      return ids
    })
  } catch (err) {
    log.error({ err, threadId }, "Could not write the brief rows for this advance")
    return []
  }
}

export interface AdvanceResult {
  advanced: boolean
  version?: number
  uptoMessageId?: string
  /** The messages the summarizer was given, for the callers that assert on it. */
  summarizedCount?: number
  reason?: "under-budget" | "under-reserve" | "no-summary" | "empty"
  /**
   * What the tail measured and what it was measured against, so the CALLER can
   * log a skip on the one condition that matters (the tail was over the budget
   * and no advance landed) instead of inferring it from the reason string. A
   * thread that is over the budget and does not advance grows its prefix
   * without bound, and that has to be one grep, never an inference.
   */
  overBudget?: boolean
  estimatedTokens?: number
  budgetTokens?: number
}

/**
 * The boundary index in `tail` such that everything AFTER it estimates at most
 * `reserve` tokens. Returns -1 when the whole tail already fits the reserve,
 * i.e. there is nothing to summarize away yet.
 *
 * THE NEWEST ROW STAYS RAW, however large. It is the message the coming turn
 * answers: the advance runs between turns, after it is stored. One message
 * over the reserve (a long paste) would otherwise land in the region, and the
 * turn would see only the brief's line about it, never the request itself.
 */
export function checkpointBoundaryIndex(
  tail: Array<{ content?: string | null; metadata?: unknown }>,
  reserve: number,
): number {
  let tokens = 0
  for (let i = tail.length - 1; i >= 0; i--) {
    // THE SAME MEASURE THE BUDGET USES (`historyRowTokens`). Counting
    // `content` alone here while the budget counts the replayed tool calls too
    // is what stopped the checkpoint advancing: a tool heavy tail is over the
    // budget by tens of thousands of tokens and yet its TEXT is a few hundred,
    // so the reserve was never filled, no boundary was ever found, and every
    // turn bounced off "under-reserve" while the prefix kept growing.
    tokens += historyRowTokens(tail[i])
    if (tokens > reserve) return Math.min(i, tail.length - 2)
  }
  return -1
}

/**
 * Advance one agent's checkpoint of one thread: summarize ONLY the messages
 * between the old and the new `uptoMessageId` (never the whole thread again)
 * and write a new immutable version.
 *
 * BETWEEN TURNS ONLY. Every step of one turn shares one assembled prefix, so
 * this is called from the turn loop's between turns position and from the
 * reactive compaction path, never from inside a turn's step loop.
 */
export async function advanceCheckpoint(params: {
  agentId: string
  threadId: string
  orgId: string
  actor: UserContext
  contextWindow?: number
  /** Runs once per advance, before the summary (P4m-T17). */
  beforeSummary?: (region: HistoryMessageRow[]) => Promise<boolean | void>
  /**
   * The REACTIVE path (compaction at 80 percent of the window). One turn whose
   * tool results blew the budget can need a checkpoint while the STORED tail is
   * still under it, so the budget gate is skipped and, if the tail is under the
   * raw reserve too, everything but the last two messages is summarized.
   */
  force?: boolean
  /**
   * How many raw tokens the advance leaves behind. Defaults to
   * `checkpointRawTailReserve(budget)` (half the budget), the planned between
   * turns reserve. The COLD RESUME path (P4c-T23) passes a smaller one: a turn
   * an hour after the last one pays for a short tail once, rather than carrying
   * half a budget of raw tokens of a conversation nobody is in any more.
   */
  tailReserveTokens?: number
  /** What the rebuild this advance causes is logged as. */
  cause?: PrefixRebuildCause
  /** Wall time since this agent's last completed turn, when the caller knows it. */
  sinceLastTurnSeconds?: number
  /**
   * The brief writer for this advance. Absent: the side-call writer. The idle
   * compaction passes one that sends the thread's own cached request with the
   * brief instruction appended (warm-compaction.ts).
   */
  writer?: CheckpointSummarizer
}): Promise<AdvanceResult> {
  const { agentId, threadId, orgId, actor } = params
  const loaded = await loadBoundedHistory({
    threadId,
    orgId,
    actor,
    agentId,
    ...(params.contextWindow ? { contextWindow: params.contextWindow } : {}),
  })
  const measured = {
    overBudget: loaded.overBudget,
    estimatedTokens: loaded.estimatedTokens,
    budgetTokens: loaded.budgetTokens,
  }
  if (loaded.messages.length === 0) return { advanced: false, reason: "empty", ...measured }
  // The budget is what TRIGGERS an advance. Below it the raw tail is rendered
  // whole, which is what keeps the prefix byte stable turn after turn.
  if (!loaded.overBudget && !params.force)
    return { advanced: false, reason: "under-budget", ...measured }

  let boundary = checkpointBoundaryIndex(
    loaded.messages,
    params.tailReserveTokens ?? checkpointRawTailReserve(loaded.budgetTokens),
  )
  if (boundary < 0 && params.force) boundary = loaded.messages.length - 3
  if (boundary < 0) return { advanced: false, reason: "under-reserve", ...measured }

  const region = loaded.messages.slice(0, boundary + 1)
  // PER AGENT (invariant I5). The summarized region is what THIS agent may
  // read: nothing before its own join point, nothing above its ceiling. Two
  // agents in one channel therefore keep two different summaries of the same
  // stretch of conversation, and an agent that joined late has no checkpoint
  // covering what happened before it arrived.
  const visibleRegion = await restrictRegionToAgent({ agentId, threadId, orgId, region })
  if (visibleRegion.length === 0) return { advanced: false, reason: "empty", ...measured }
  // THE FLUSH RUNS FIRST, ONCE PER ADVANCE (spec-memory.md L4). It cannot fire
  // twice for one version (there is one call, and the version row records it)
  // and it cannot be skipped when the summary is about to run: the only way
  // past it is the tainted or over budget refusal inside the flush itself.
  // THE REGION MARKER IS SHARED WITH CONSOLIDATION (P4m-T25). An advance's
  // region is one region among several, not a special case: a quiet close or a
  // routine tick close that already flushed this stretch must not be flushed
  // again here, and vice versa.
  const flushed = params.beforeSummary
    ? (await params.beforeSummary(visibleRegion)) === true
    : await flushRegionThroughConsolidation({ agentId, orgId, threadId, region: visibleRegion })

  // THE BRIEF, NOT A GENERIC SUMMARY (P4c-T24). One incremental call on the
  // org's compaction model: the brief so far plus THIS region, under the
  // bench's prompt, and what comes back is split into the core the checkpoint
  // carries and the one episode this region leaves behind.
  const writer = params.writer ?? summarizerOverride ?? defaultCheckpointSummarizer
  const prompt = await loadBriefPrompt()
  // A50: the brief writer never sees a retrieval tool part.
  const writerMessages = convertRegion(stripRetrievalToolParts(visibleRegion), {
    selfAgentId: agentId,
    labels: await labelsForRegion(orgId, visibleRegion, agentId),
  })
  const briefText = await writer({
    orgId,
    threadId,
    actor,
    prompt,
    // A STALE brief is never folded forward: it quotes what was deleted.
    previousSummary: loaded.checkpoint?.summary ?? null,
    messages: writerMessages,
    regionRows: visibleRegion,
    keptRows: loaded.messages.slice(boundary + 1),
  })
  if (!briefText || briefText.trim().length === 0) {
    return { advanced: false, reason: "no-summary", ...measured }
  }
  log.info(
    {
      threadId,
      agentId,
      brief_tokens_in:
        estimateTokens(prompt) +
        estimateTokens(loaded.checkpoint?.summary ?? "") +
        estimateTokens(
          writerMessages
            .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
            .join("\n"),
        ),
      brief_tokens_out: estimateTokens(briefText),
    },
    "checkpoint_brief_written",
  )
  const split = splitBrief(briefText)

  // Versions are serial per (agent, thread) whether or not the previous one was
  // rendered: a stale version still occupies its number.
  const version = (loaded.checkpoint?.version ?? loaded.staleCheckpoint?.version ?? 0) + 1
  const uptoMessageId = region[region.length - 1].id
  // P4c-T49: the rows first, then the version row that freezes a core rendered
  // FROM them. The other order would freeze a core that is one region stale on
  // the very advance that produced the region.
  const briefRowIds = await writeBriefRowsForRegion({
    orgId,
    threadId,
    agentId,
    region: visibleRegion,
  })
  // THE CORE is the brief's own first three sections followed by the structured
  // rows of the same stretch, clipped ONCE at BRIEF_CORE_TOKEN_BUDGET on a line
  // boundary. The rows sit at the end because they are the half that can be
  // rebuilt from the table: when the core does not fit, the prose the writer
  // chose survives and the rows lose first.
  const joinPoint = await agentJoinPoint({ agentId, threadId, orgId })
  const rowCore = await renderRowCore({ orgId, threadId, agentId, uptoMessageId, joinPoint })
  const rawCore = [split.core, rowCore].filter((part) => part.length > 0).join("\n")
  const { text: core, clipped: coreClipped } = clipToTokenBudget(rawCore, BRIEF_CORE_TOKEN_BUDGET)
  if (coreClipped) {
    log.info(
      { threadId, agentId, version, budgetTokens: BRIEF_CORE_TOKEN_BUDGET },
      "brief_core_clipped",
    )
  }
  // ONE EPISODE FOR THE REGION: the sections the core does not carry, titled by
  // the region's date span and its first decision. Episodes are FETCHED, so
  // only their titles ever ride forward.
  const { text: episodeBody } = clipToTokenBudget(split.episode, BRIEF_EPISODE_TOKEN_BUDGET)
  const episodeTitles = await withPrivilegedDb(orgId, "checkpoint-episode", async (tx) => {
    if (episodeBody.length > 0) {
      await upsertEpisode(tx, {
        orgId,
        threadId,
        title: episodeTitle({ region: visibleRegion, core }),
        body: episodeBody,
        spanStartMessageId: visibleRegion[0]?.id ?? null,
        spanEndMessageId: visibleRegion[visibleRegion.length - 1]?.id ?? null,
        messageIds: visibleRegion.map((m) => m.id),
      })
    }
    return recentEpisodeTitles(tx, { orgId, threadId })
  }).catch((err) => {
    log.error({ err, threadId, agentId }, "Could not write this region's episode")
    return [] as string[]
  })
  const summary = composeSummary(core, episodeTitles)
  // The brief folds the previous one forward, so outside text in either stays outside text,
  // unless a person cleared it since (replayed-outside-text.ts).
  const clearedAt = await loadTaintClearedAt(threadId, orgId)
  const tainted =
    (loaded.checkpoint?.tainted === true &&
      !clearedByPerson({ createdAt: loaded.checkpoint.createdAt }, clearedAt)) ||
    (await replaysOutsideText(visibleRegion, orgId, { clearedAt }))
  const checkpointId = await withPrivilegedDb(orgId, "checkpoint-advance", async (tx) => {
    const [written] = await tx
      .insert(agentThreadCheckpoints)
      .values({
        orgId,
        agentId,
        threadId,
        uptoMessageId,
        summary,
        requiredScopes: summaryRequiredScopes(visibleRegion, orgId),
        tokenEstimate: estimateTokens(summary),
        version,
        tainted,
        ...(flushed ? { flushedAt: new Date() } : {}),
      })
      .returning({ id: agentThreadCheckpoints.id })
    // The clean version supersedes every stale one of this (agent, thread), so
    // the flag they carry has nothing left to say: clearing it keeps the tab
    // and the next load from reporting a staleness the rebuild just answered.
    await tx
      .update(agentThreadCheckpoints)
      .set({ staleAt: null })
      .where(
        and(
          eq(agentThreadCheckpoints.orgId, orgId),
          eq(agentThreadCheckpoints.agentId, agentId),
          eq(agentThreadCheckpoints.threadId, threadId),
        ),
      )
    return written?.id ?? null
  })
  // THE CORE IS FROZEN ON THE CHECKPOINT ROW, in `core_brief` (0094). It is the
  // SAME string the summary opens with, rendered once at advance time through
  // this agent's own window (its join point, its checkpoint boundary) and then
  // never re-rendered: a core that re-rendered per turn would change bytes the
  // moment a later region superseded one of its lines, and a prefix that
  // changes is a cache miss on every turn (I3).
  //
  // SINCE P4c-T24 THE COLUMN IS REDUNDANT rather than independent: `summary` is
  // `core_brief` plus the episode title lines, so the two cannot disagree by
  // construction. It is kept because it is the core WITHOUT those titles, which
  // is what a reader that only wants the facts asks for, and dropping a shipped
  // column buys nothing.
  if (checkpointId) {
    try {
      await withPrivilegedDb(orgId, "checkpoint-core-freeze", (tx) =>
        tx.execute(
          drizzleSql`UPDATE ${drizzleSql.raw(schemaRef("kernel"))}.agent_thread_checkpoints
                     SET core_brief = ${core} WHERE id = ${checkpointId}`,
        ),
      )
    } catch (err) {
      // The version row is already written and renders exactly as it did before
      // this slice; losing its core costs the rows' shortcut, not the advance.
      log.error({ err, threadId, agentId }, "Could not freeze the core on this checkpoint")
    }
  }
  if (briefRowIds.length > 0) {
    try {
      const { enqueueBriefIndexing } = await import("~/modules/search/message-indexer")
      await enqueueBriefIndexing(orgId, "brief_row", briefRowIds)
    } catch (err) {
      log.error({ err, threadId }, "Could not queue brief row indexing")
    }
  }
  await logHistoryPrefixRebuilt({
    cause: params.cause ?? "checkpoint",
    orgId,
    threadId,
    agentId,
    version,
    actor,
    ...(params.sinceLastTurnSeconds !== undefined
      ? { sinceLastTurnSeconds: params.sinceLastTurnSeconds }
      : {}),
  })
  // Trigger (c): an advance closes an episode (spec-memory.md L5). The job runs
  // in the background, so a failure to enqueue costs the episode file, never
  // the advance that just landed.
  try {
    const { closeEpisode } = await import("~/modules/agent/memory/consolidation")
    await closeEpisode({
      orgId,
      agentId,
      threadId,
      closeReason: "checkpoint",
      fromMessageId: region[0].id,
      toMessageId: uptoMessageId,
    })
  } catch (err) {
    log.error({ err, threadId }, "Could not enqueue consolidation for this checkpoint advance")
  }
  return { advanced: true, version, uptoMessageId, summarizedCount: visibleRegion.length }
}

/**
 * The advance's flush, routed through consolidation's per region marker so the
 * two close paths cannot flush the same stretch twice. Imported lazily: the
 * consolidation module imports this one for the advance, and a static edge both
 * ways is a cycle.
 */
async function flushRegionThroughConsolidation(params: {
  agentId: string
  orgId: string
  threadId: string
  region: HistoryMessageRow[]
}): Promise<boolean> {
  try {
    const { flushRegion } = await import("~/modules/agent/memory/consolidation")
    const result = await flushRegion(
      {
        orgId: params.orgId,
        agentId: params.agentId,
        threadId: params.threadId,
        closeReason: "checkpoint",
        ...(params.region[0] ? { fromMessageId: params.region[0].id } : {}),
        ...(params.region.length > 0
          ? { toMessageId: params.region[params.region.length - 1].id }
          : {}),
      },
      params.region.map((m) => ({
        id: m.id,
        content: m.content ?? null,
        createdAt: m.createdAt,
        requiredScopes: m.requiredScopes ?? [],
        disclosureList: null,
        authorType: m.authorType,
        authorId: m.authorId ?? null,
      })),
    )
    // An already flushed region counts as flushed for the version row: the
    // facts are in memory either way, which is the only thing the marker is
    // asserting.
    return result.flushed || result.alreadyFlushed
  } catch (err) {
    log.error({ err, threadId: params.threadId }, "Memory flush could not run for this advance")
    return false
  }
}

/**
 * A POSITION in the thread's message order, not an instant: the FIRST message
 * this agent may see, by the list's own (created_at, id) order.
 *
 * The cut used to be a JS Date comparison, and a JS Date carries milliseconds
 * while the stored timestamp carries microseconds, so a seat and the messages
 * around it inside one millisecond could not be ordered at all: every one of
 * them entered the tail, including the ones written BEFORE the agent sat down.
 * The anchor is resolved in SQL, where the timestamp keeps its precision, and
 * the tail is sliced at it rather than compared against it.
 */
export interface JoinPoint {
  createdAt: Date
  id: string
}

/**
 * When this agent joined the room, or null when it has no seat of its own (a
 * DM, where the agent is the other side of the conversation rather than a
 * seated member). An agent that joined a channel late has no history and no
 * checkpoint before its join point, which is the mention auto add rule.
 */
export async function agentJoinPoint(params: {
  agentId: string
  threadId: string
  orgId: string
}): Promise<JoinPoint | null> {
  const { agentId, threadId, orgId } = params
  // ONE query: the seat's timestamp never travels through a JS Date, which is
  // what lost the microseconds that separate a seat from the messages written
  // in the same millisecond.
  // Schema-qualified through schemaRef like every raw query here: a hard-coded
  // `kernel.` read the base schema in a prefixed test lane, found no seat
  // message there, and left every seated agent's tail EMPTY.
  const K = drizzleSql.raw(schemaRef("kernel"))
  const rows = await withPrivilegedDb(orgId, "checkpoint-agent-seat", async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT m.id, m.created_at AS created_at
      FROM ${K}.messages m
      WHERE m.thread_id = ${threadId}
        AND m.org_id = ${orgId}
        AND m.deleted_at IS NULL
        -- The CHANNEL's join point (A8): a hidden reply is never in the channel
        -- tail this anchor slices, so anchoring on one left the tail empty.
        AND (m.reply_root_id IS NULL OR m.also_in_channel)
        AND m.created_at >= (
          SELECT p.created_at FROM ${K}.thread_participants p
          WHERE p.thread_id = ${threadId} AND p.agent_id = ${agentId} AND p.org_id = ${orgId}
          LIMIT 1
        )
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT 1`)
    return ((result as { rows?: Record<string, unknown>[] }).rows ??
      (result as Record<string, unknown>[])) as Array<{ id: string; created_at: string | Date }>
  })
  const anchor = rows[0]
  return anchor ? { createdAt: new Date(anchor.created_at), id: anchor.id } : null
}

/** Does this agent hold a seat of its own in the thread? */
export async function agentSeatedInThread(params: {
  agentId: string
  threadId: string
  orgId: string
}): Promise<boolean> {
  const { agentId, threadId, orgId } = params
  const [seat] = await withPrivilegedDb(orgId, "checkpoint-agent-seat", (tx) =>
    tx
      .select({ id: threadParticipants.id })
      .from(threadParticipants)
      .where(
        and(
          eq(threadParticipants.threadId, threadId),
          eq(threadParticipants.agentId, agentId),
          eq(threadParticipants.orgId, orgId),
        ),
      )
      .limit(1),
  )
  return Boolean(seat)
}

/**
 * The region as THIS agent may read it: within its scope ceiling. The join
 * point is applied earlier, by the bounded load, because it bounds the whole
 * per agent TAIL and not just the summarized region.
 */
async function restrictRegionToAgent(params: {
  agentId: string
  threadId: string
  orgId: string
  region: HistoryMessageRow[]
}): Promise<HistoryMessageRow[]> {
  const { agentId, orgId, region } = params
  const [agent] = await withPrivilegedDb(orgId, "checkpoint-agent-ceiling", (tx) =>
    tx
      .select({ scopeCeiling: agents.scopeCeiling })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
      .limit(1),
  )
  const ceiling = Array.isArray(agent?.scopeCeiling) ? (agent.scopeCeiling as string[]) : []
  return region.filter((m) => {
    return isMessageVisible(
      { requiredScopes: m.requiredScopes ?? [], disclosureList: null },
      { userId: "", grants: ceiling },
    )
  })
}

/**
 * A50 (P4c-T50). The same rows with every RETRIEVAL tool part removed from
 * their metadata: a memory_search or threads_search result must never be folded
 * into a brief, because a brief is recalled and replayed, and a search result
 * that comes back as recalled memory is the agent quoting itself.
 *
 * Pure and non mutating: nothing is deleted from any stored row, and the thread
 * view keeps showing the call as activity. Business tool parts are untouched.
 */
export function stripRetrievalToolParts(rows: HistoryMessageRow[]): HistoryMessageRow[] {
  return rows.map((row) => {
    const meta = row.metadata as { toolCalls?: Array<{ toolName?: string }> } | null
    if (!meta || !Array.isArray(meta.toolCalls) || meta.toolCalls.length === 0) return row
    const kept = meta.toolCalls.filter((tc) => !isRetrievalTool(String(tc?.toolName ?? "")))
    if (kept.length === meta.toolCalls.length) return row
    const { toolCalls: _dropped, ...rest } = meta
    return {
      ...row,
      metadata: kept.length > 0 ? { ...rest, toolCalls: kept } : rest,
    } as HistoryMessageRow
  })
}

/**
 * The region as chat messages, without pulling the whole renderer in.
 *
 * Every line carries its MESSAGE ID: the brief's first rule is that a line it
 * writes ends with the ids it came from, and a region handed over without ids
 * makes that rule unfollowable. The surviving tool calls are named (never their
 * results) so the brief can say an action was taken; the retrieval ones are
 * already gone by A50, so naming what is left cannot replay a search.
 */
function convertRegion(
  region: HistoryMessageRow[],
  attribution?: { selfAgentId?: string | null; labels?: Map<string, string> },
): Array<{ role: string; content: unknown }> {
  return region.map((m) => {
    const meta = m.metadata as { toolCalls?: Array<{ toolName?: string }> } | null
    const tools = Array.isArray(meta?.toolCalls)
      ? meta.toolCalls.map((tc) => String(tc?.toolName ?? "")).filter((n) => n.length > 0)
      : []
    const { role, body } = attributedLine(m, attribution)
    return {
      role,
      content: tools.length > 0 ? `${body}\n[tools called: ${tools.join(", ")}]` : body,
    }
  })
}

/**
 * One region row, as a role and a body, with a COLLEAGUE's row attributed.
 *
 * The message id prefix stays first and stays exactly where it was: the
 * brief's first rule is that every line it writes ends with the ids it came
 * from, so moving or dropping that prefix makes the rule unfollowable. The
 * label goes after it, and only for a row this agent did not write.
 */
function attributedLine(
  m: HistoryMessageRow,
  attribution?: { selfAgentId?: string | null; labels?: Map<string, string> },
): { role: "user" | "assistant"; body: string } {
  const text = `[${m.id}] ${m.content ?? ""}`
  if (m.authorType === "user") return { role: "user", body: text }
  const external = externalClientLabel(m)
  if (external) {
    return { role: "user", body: `[${m.id}] ${foreignAgentLine(external, m.content ?? "")}` }
  }
  const foreign = foreignAuthorOf(m, attribution?.selfAgentId)
  if (!foreign) return { role: "assistant", body: text }
  const label = attribution?.labels?.get(foreign) ?? UNKNOWN_AGENT_LABEL
  // A colleague's line is not this agent's prior turn, so it is not replayed
  // as one: summarized as `assistant` it entered the checkpoint as something
  // this agent had said, and every later turn of the thread then carried it.
  return { role: "user", body: `[${m.id}] ${foreignAgentLine(label, m.content ?? "")}` }
}

/**
 * The structured half of the core: T49's rows for this stretch, as this agent
 * may see them. A failure here costs the rows' lines, never the advance.
 */
async function renderRowCore(params: {
  orgId: string
  threadId: string
  agentId: string
  uptoMessageId: string
  joinPoint: JoinPoint | null
}): Promise<string> {
  try {
    return await withPrivilegedDb(params.orgId, "checkpoint-row-core", (tx) =>
      renderCore(tx, {
        orgId: params.orgId,
        threadId: params.threadId,
        agentId: params.agentId,
        uptoMessageId: params.uptoMessageId,
        joinPointMessageId: params.joinPoint?.id ?? null,
      }),
    )
  } catch (err) {
    log.error({ err, threadId: params.threadId }, "Could not render this thread's brief rows")
    return ""
  }
}

// --- The rebuild log line (P4m-T18) ---------------------------------------

/**
 * The causes a prefix rebuild may carry (spec-memory.md I3, I4). `cold_resume`
 * is the third (P4c-T23): a turn long after the last one rebuilds the prefix
 * deliberately, and it is told apart from the planned budget advance so "how
 * often does this thread rebuild" stays an answerable question.
 */
export type PrefixRebuildCause = "checkpoint" | "revoke" | "cold_resume"

/**
 * The one place `history_prefix_rebuilt` is emitted. It goes to the structured
 * log AND to the audit trail, because "how often did this thread rebuild its
 * prefix" is a question asked after the fact, from stored rows, not from a log
 * buffer. ASCII only, and nothing else in the slice emits this name.
 */
/**
 * Revokes already reported in this process, so a message that stays hidden
 * reports ONE rebuild rather than one per turn for the rest of the thread's
 * life. The rebuild really does happen once: the turn after it renders the
 * narrowed history, and every later turn renders the same thing.
 */
const reportedRevokes = new Set<string>()

/** Report a revoke forced rebuild, at most once per hidden set per process. */
export async function reportRevokeRebuild(params: {
  orgId: string
  threadId: string
  agentId: string
  actor: UserContext
  hiddenMessageIds: string[]
}): Promise<boolean> {
  if (params.hiddenMessageIds.length === 0) return false
  const key = `${params.threadId}:${params.agentId}:${[...params.hiddenMessageIds].sort().join(",")}`
  if (reportedRevokes.has(key)) return false
  reportedRevokes.add(key)
  await logHistoryPrefixRebuilt({
    cause: "revoke",
    orgId: params.orgId,
    threadId: params.threadId,
    agentId: params.agentId,
    version: null,
    actor: params.actor,
  })
  return true
}

export async function logHistoryPrefixRebuilt(params: {
  cause: PrefixRebuildCause
  orgId: string
  threadId: string
  agentId: string
  version: number | null
  actor: UserContext
  /** Wall time since the agent's last completed turn, on the causes that have one. */
  sinceLastTurnSeconds?: number
}): Promise<void> {
  const { cause, orgId, threadId, agentId, version, sinceLastTurnSeconds } = params
  log.info(
    {
      cause,
      threadId,
      agentId,
      version,
      ...(sinceLastTurnSeconds !== undefined ? { sinceLastTurnSeconds } : {}),
    },
    "history_prefix_rebuilt",
  )
  try {
    await withPrivilegedDb(orgId, "history-prefix-rebuilt-audit", (tx) =>
      writeAuditLog(tx, {
        orgId,
        actorId: params.actor.userId,
        actorType: "system",
        app: "kernel",
        entityType: "thread",
        entityId: threadId,
        action: "history_prefix_rebuilt",
        agentId,
        metadata: {
          cause,
          version,
          ...(sinceLastTurnSeconds !== undefined ? { sinceLastTurnSeconds } : {}),
        },
      }),
    )
  } catch (err) {
    // The rebuild already happened; losing its record must not take the turn
    // down with it.
    log.error({ err, threadId, agentId, cause }, "Could not record history_prefix_rebuilt")
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const CheckpointTestAccess = {
  /**
   * Swap the checkpoint summarizer. The seam a test drives, mirroring
   * `AgentServiceTestAccess.setStreamText`: production never calls this, and
   * calling it with no argument restores the real cheap model call.
   */
  setSummarizer(fn?: CheckpointSummarizer): void {
    if (!isTestEnv()) {
      throw new Error("CheckpointTestAccess.setSummarizer is only available in tests")
    }
    summarizerOverride = fn
  },

  /** Swap the brief row extractor. The seam a test drives; production never calls it. */
  setBriefRowExtractor(fn?: BriefRowExtractor): void {
    if (!isTestEnv()) {
      throw new Error("CheckpointTestAccess.setBriefRowExtractor is only available in tests")
    }
    briefRowExtractorOverride = fn
  },

  /** Forget the reported revokes. Test isolation only. */
  resetReportedRevokes(): void {
    reportedRevokes.clear()
  },
}
