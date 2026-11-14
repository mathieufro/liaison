// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * THE FALSE APPROVAL CLAIM GUARD: an answer that says something awaits the
 * person's approval must be backed by an approval this turn parked.
 *
 * A weak model loaded a gated tool, ran the preparation reads, then answered
 * "staged, pending your approval" without ever calling the gated tool: no
 * approval request existed, so nothing would ever reach the person. App
 * guides already forbade exactly that claim, in capitals. Prose did not hold,
 * so the runtime checks the answer against what the turn did.
 *
 * When the model loop ends, the turn's final text (written after its last
 * tool call) is read for the claim (`false-approval-claim.ts`). It is false
 * when either:
 *   - it claims something is staged or pending approval and no approval was
 *     parked this turn: no tool result carried a parked envelope, and no
 *     approval request was created for the person since the turn started
 *     (that query also covers approvals parked by a sub-agent or a sequenced
 *     bundle, whose envelopes may not reach this stream);
 *   - it cites an approval handle (`request-N`) that no tool returned this
 *     turn, no approval created this turn carries, and no approval of this
 *     thread has.
 * A claim whose cited handles are all known is a report about earlier
 * approvals, not a false one.
 *
 * Whether a gated tool was available is not part of the test: gating is
 * config dependent (an org's approval policy can gate any tool), and the
 * kernel's own gated tools are always loaded, so that filter would add no
 * precision and would miss policy-gated tools.
 *
 * Then the same turn continues ONCE: the runtime note is appended as a user
 * message after the turn's own messages, and the model answers again, with
 * its tools, so it can call the gated tool or say plainly what it did not do.
 * The corrected answer REPLACES the false text in the stored reply (the
 * person reads one answer, never a claim followed by its retraction, and the
 * next turn's history does not carry the false claim as a pattern to repeat).
 * Live viewers saw the false text stream; a blank line separates it from the
 * correction, and the stored row drops it.
 */

import type { TurnTimelineEntry } from "~/modules/agent/runtime/agent-service"
import { claimsFreshAction } from "~/modules/agent/runtime/announced-action-claim"
import { claimedCards, type ThreadCards } from "~/modules/agent/runtime/card-claim"
import {
  approvalHandlesIn,
  claimsPendingApproval,
} from "~/modules/agent/runtime/false-approval-claim"
import { threadHasSecretRequest } from "~/modules/agent/runtime/open-cards"
import { replyTextOfSteps } from "~/modules/agent/runtime/reply-flatten"
import { isParkedForApproval } from "~/modules/agent/tools/tool-bridge"
import {
  approvalHandlesRequestedSince,
  threadApprovalHandles,
  threadHasPendingApproval,
} from "~/modules/approvals/resolve-ref"

/** How many steps the corrective continuation may take. */
export const FALSE_APPROVAL_CORRECTION_MAX_STEPS = 6

/** Written between the false text and the correction on the live stream. */
export const CORRECTION_SEPARATOR = "\n\n"

/** Some tool result holds a parked approval envelope, at any depth. */
export function containsParkedApproval(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== "object" || depth > 6) return false
  if (isParkedForApproval(value)) return true
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
  return values.some((v) => containsParkedApproval(v, depth + 1))
}

/** Every `request-N` handle the tool results carry. */
export function handlesInToolOutputs(outputs: readonly unknown[]): Set<string> {
  const handles = new Set<string>()
  for (const output of outputs) {
    let text: string
    try {
      text = typeof output === "string" ? output : (JSON.stringify(output) ?? "")
    } catch {
      continue
    }
    for (const h of approvalHandlesIn(text)) handles.add(h)
  }
  return handles
}

export type FalseApprovalReason = "claim_without_approval" | "unknown_handle"

export interface FalseApprovalLookups {
  /** Handles of approvals requested for the person since the turn started. */
  approvalsCreatedSince(): Promise<string[]>
  /** Which of `handles` belong to approvals of this thread. */
  threadHandles(handles: string[]): Promise<string[]>
  /** The cards this thread holds: a secret request in any status, an approval still waiting. */
  threadCards(): Promise<ThreadCards>
}

/** A tool result that opened a secure card (request_secret's `{ requestId, kind }`), at any depth. */
export function containsSecretRequest(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== "object" || depth > 6) return false
  const r = value as { requestId?: unknown; kind?: unknown }
  if (typeof r.requestId === "string" && typeof r.kind === "string") return true
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
  return values.some((v) => containsSecretRequest(v, depth + 1))
}

/**
 * A tool result that draws a card under its call (`card: "shown"`: the Drive
 * picker card), at any depth. Such a card is in the
 * conversation for the person to act on, so it backs "the card is waiting for you below".
 */
export function containsShownCard(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== "object" || depth > 4) return false
  if (!Array.isArray(value) && (value as { card?: unknown }).card === "shown") return true
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
  return values.some((v) => containsShownCard(v, depth + 1))
}

/**
 * What one tool result says the call did, for the text written before it:
 *   - `acted`: it parked an approval or posted a secure card;
 *   - `no_change`: nothing to do (`changed: false`, config tools' no-op);
 *   - `already_posted`: the same card was already in the conversation, none posted;
 *   - `refused`: the call was refused (`{ error }`);
 *   - `other`: anything else (a read, a write that reports no such flag).
 */
export type ToolOutcome = "acted" | "no_change" | "already_posted" | "refused" | "other"

function someDeep(
  value: unknown,
  test: (o: Record<string, unknown>) => boolean,
  depth = 0,
): boolean {
  if (value === null || typeof value !== "object" || depth > 4) return false
  if (!Array.isArray(value) && test(value as Record<string, unknown>)) return true
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
  return values.some((v) => someDeep(v, test, depth + 1))
}

export function toolOutcome(output: unknown): ToolOutcome {
  if (output === null || typeof output !== "object") return "other"
  if (containsParkedApproval(output) || someDeep(output, (o) => o.card === "posted")) return "acted"
  if (someDeep(output, (o) => o.card === "already_posted")) return "already_posted"
  if (
    someDeep(output, (o) => o.changed === false) &&
    !someDeep(output, (o) => o.changed === true)
  ) {
    return "no_change"
  }
  const top = output as { error?: unknown }
  if (top.error !== undefined && top.error !== null && top.error !== false) return "refused"
  return "other"
}

/**
 * TEXT WRITTEN BEFORE A TOOL CALL THAT THE CALL'S RESULT CONTRADICTS.
 *
 * Measured failures (a weak model, live check 2026-10-27): the model writes
 * the outcome before its call returns, then the result says otherwise, and
 * the reply carries both:
 *   - "I have submitted a request to enable the Tickets app. Please approve
 *     the pending approval card…" then `config_apps` → `changed: false`, no
 *     approval: "…Tickets is already enabled.";
 *   - "I have posted the connect card again above." then `request_secret` →
 *     `already_posted`: "…The connection card is already right above."
 * The text before the call claims something done or waiting (a fresh action,
 * a pending approval, a card it posted), the turn's LAST tool result is a
 * no-op, a dedupe or a refusal, and no call of the turn parked an approval or
 * posted a card. The answer written after that result (the final text) was
 * written knowing it, so the stored reply keeps it and withholds the text
 * before. A turn that called another tool last (a retry that went through),
 * or acted somewhere, is left alone.
 */
export function preCallTextContradicted(
  preCallText: string,
  toolOutputs: readonly unknown[],
): Exclude<ToolOutcome, "acted" | "other"> | null {
  if (preCallText.trim().length === 0 || toolOutputs.length === 0) return null
  const outcomes = toolOutputs.map(toolOutcome)
  if (outcomes.includes("acted")) return null
  const last = outcomes[outcomes.length - 1]
  if (last === "acted" || last === "other") return null
  const claims =
    claimsFreshAction(preCallText) ||
    claimsPendingApproval(preCallText) ||
    claimedCards(preCallText).size > 0
  return claims ? last : null
}

/**
 * Why the turn's final text is a false approval claim, or null. The lookups
 * run only once the text claims something or cites a handle.
 */
export async function assessFalseApprovalClaim(
  finalText: string,
  toolOutputs: readonly unknown[],
  lookups: FalseApprovalLookups,
): Promise<FalseApprovalReason | null> {
  const claim = claimsPendingApproval(finalText)
  const cited = approvalHandlesIn(finalText)
  if (!claim && cited.length === 0) return null
  const parkedInStream = toolOutputs.some((o) => containsParkedApproval(o))
  const returned = handlesInToolOutputs(toolOutputs)
  let unknown = cited.filter((h) => !returned.has(h))
  if (!(claim && !parkedInStream) && unknown.length === 0) return null

  const created = await lookups.approvalsCreatedSince()
  const createdSet = new Set(created.map((h) => h.toLowerCase()))
  unknown = unknown.filter((h) => !createdSet.has(h))
  if (unknown.length > 0) {
    const known = new Set((await lookups.threadHandles(unknown)).map((h) => h.toLowerCase()))
    unknown = unknown.filter((h) => !known.has(h))
  }
  if (unknown.length > 0) return "unknown_handle"
  // Every handle the text cites is real: a report on known approvals.
  if (cited.length > 0) return null
  if (claim && !parkedInStream && created.length === 0) return "claim_without_approval"
  return null
}

/** The database half of the lookups, for one turn. */
export function falseApprovalLookups(params: {
  orgId: string
  threadId: string
  userId: string
  turnStartedAt: Date
}): FalseApprovalLookups {
  const { orgId, threadId, userId } = params
  // A little slack for clock drift between this process and the database.
  const since = new Date(params.turnStartedAt.getTime() - 5_000)
  return {
    approvalsCreatedSince: () => approvalHandlesRequestedSince(orgId, userId, since),
    threadHandles: (handles) => threadApprovalHandles(orgId, threadId, handles),
    threadCards: async () => {
      const [secret, approval] = await Promise.all([
        threadHasSecretRequest(orgId, threadId),
        threadHasPendingApproval(orgId, threadId),
      ])
      return { secret, approval }
    },
  }
}

/** What the first run of the turn did, as its stream showed it. */
export interface ObservedRun {
  /** The text written after the run's last tool call. */
  finalText: string
  /** Every text the run wrote, before and after its tool calls. */
  allText: string
  /** Every tool result of the run. */
  toolOutputs: unknown[]
}

/** What the corrective continuation wrote, and whether it called a tool. */
export interface ObservedContinuation {
  text: string
  calledTool: boolean
}

/** The false text the stored reply drops: the characters ending at `end` of the turn's text. */
export interface Retraction {
  end: number
  text: string
}

type Chunk = { type?: string; text?: string; output?: unknown; finishReason?: string }
type StreamLike = {
  fullStream: AsyncIterable<unknown>
  responseMessages?: PromiseLike<unknown[]>
}

/**
 * The turn's stream, with at most one corrective continuation appended. The
 * first run's `finish` chunk is held until the guard has decided, so a
 * consumer that finalizes on `finish` finalizes once, after the correction.
 */
export async function* withFalseApprovalGuard(opts: {
  first: StreamLike
  /**
   * The verdict on the finished first run; true runs the correction, which
   * replaces the text written after the last tool call; "all" replaces every
   * text the run wrote (a false claim written before a tool call);
   * "precall" runs no correction and withholds the text written before the
   * last tool call (`preCallTextContradicted`): the final text stays.
   */
  shouldCorrect: (run: ObservedRun) => Promise<boolean | "all" | "precall">
  /** The corrective continuation, given the first run's response messages. */
  continueWith: (responseMessages: unknown[]) => StreamLike
  /** The stored reply's cut; null when nothing is cut after all (a dropped continuation). */
  onRetract: (retraction: Retraction | null) => void
  /**
   * The verdict on the finished continuation. Absent, it is always kept and
   * streams as it comes. Present, the continuation's text is HELD until the
   * verdict, or until its first tool call (a continuation that calls a tool
   * is always kept): kept, the held text is released; dropped, it is never
   * streamed, the first answer stays, and `droppedNotice` (a fixed platform
   * line, never model text) is streamed and stored after it. So what a live
   * viewer saw of the continuation is what the stored reply keeps.
   */
  keepContinuation?: (run: ObservedContinuation) => boolean
  /** Whether this correction asks the verdict (read once the correction starts); default yes. */
  holdContinuation?: () => boolean
  /** The platform line a dropped continuation leaves after the first answer. */
  droppedNotice?: (first: ObservedRun) => string
  /**
   * One more continuation, for a correction that again ends on the turn's own
   * plan: its last step called no tool and `shouldCorrect` reads its final text
   * as unfinished. The plan text is cut from the stored reply (`onRetractAgain`
   * when it was already streamed) and `continueWith` runs, given the first
   * run's and the correction's response messages. Its verdict replaces
   * `keepContinuation` for that correction. Bounded: never a third.
   */
  correctAgain?: {
    shouldCorrect: (continuation: { finalText: string }) => Promise<boolean>
    continueWith: (firstMessages: unknown[], correctionMessages: unknown[]) => StreamLike
  }
  /** A second cut of the stored reply: the correction's own plan text, already streamed. */
  onRetractAgain?: (retraction: Retraction) => void
}): AsyncGenerator<unknown> {
  let textLength = 0
  let finalText = ""
  let allText = ""
  const toolOutputs: unknown[] = []
  let sawError = false
  let lastStepCalledTool = false
  let stepCalledTool = false
  let lastFinishReason: string | undefined
  let heldFinish: unknown = null

  for await (const raw of opts.first.fullStream) {
    const chunk = raw as Chunk
    switch (chunk.type) {
      case "text-delta":
        textLength += chunk.text?.length ?? 0
        finalText += chunk.text ?? ""
        allText += chunk.text ?? ""
        break
      case "tool-call":
        stepCalledTool = true
        finalText = ""
        break
      case "tool-result":
        toolOutputs.push(chunk.output)
        break
      case "error":
      case "abort":
        sawError = true
        break
      case "finish-step":
        lastStepCalledTool = stepCalledTool
        stepCalledTool = false
        lastFinishReason = chunk.finishReason
        break
      case "finish":
        heldFinish = raw
        continue
    }
    yield raw
  }

  const eligible =
    !sawError &&
    !lastStepCalledTool &&
    (lastFinishReason === undefined || lastFinishReason === "stop") &&
    finalText.trim().length > 0 &&
    opts.first.responseMessages !== undefined
  const verdict = eligible ? await opts.shouldCorrect({ finalText, allText, toolOutputs }) : false
  if (verdict === "precall") {
    // The answer after the last tool result is kept; the text before is cut
    // from the stored reply. Nothing more streams.
    const before = allText.slice(0, allText.length - finalText.length)
    opts.onRetract({ end: before.length, text: before })
    if (heldFinish) yield heldFinish
    return
  }
  if (verdict) {
    const responseMessages = await opts.first.responseMessages!
    yield { type: "text-delta", id: "false-approval-correction", text: CORRECTION_SEPARATOR }
    opts.onRetract({
      end: textLength + CORRECTION_SEPARATOR.length,
      text: (verdict === "all" ? allText : finalText) + CORRECTION_SEPARATOR,
    })
    let continuationText = ""
    let calledTool = false
    let heldContinuationFinish: unknown = null
    // Text held until the verdict; null once released (or when no verdict is asked).
    let heldText: unknown[] | null =
      opts.keepContinuation && (opts.holdContinuation?.() ?? true) ? [] : null
    // The correction's own ending, read for `correctAgain`.
    let contFinalText = ""
    let contStepCalledTool = false
    let contLastStepCalledTool = false
    let contFinishReason: string | undefined
    let contError = false
    // Turn text streamed so far, the separator included.
    let streamedLength = textLength + CORRECTION_SEPARATOR.length
    const continuation = opts.continueWith(responseMessages)
    for await (const raw of continuation.fullStream) {
      const chunk = raw as Chunk
      if (chunk.type === "text-delta") {
        continuationText += chunk.text ?? ""
        contFinalText += chunk.text ?? ""
        if (heldText) {
          heldText.push(raw)
          continue
        }
        streamedLength += chunk.text?.length ?? 0
      } else if (chunk.type === "tool-call") {
        calledTool = true
        contStepCalledTool = true
        contFinalText = ""
        // A tool call keeps the continuation: what it wrote before is released, in order.
        if (heldText) {
          for (const held of heldText) streamedLength += (held as Chunk).text?.length ?? 0
          yield* heldText
          heldText = null
        }
      } else if (chunk.type === "finish-step") {
        contLastStepCalledTool = contStepCalledTool
        contStepCalledTool = false
        contFinishReason = chunk.finishReason
      } else if (chunk.type === "error" || chunk.type === "abort") {
        contError = true
      } else if (chunk.type === "finish") {
        // Held until the verdict below: a consumer finalizes on `finish`.
        heldContinuationFinish = raw
        continue
      }
      yield raw
    }
    if (
      opts.correctAgain &&
      !contError &&
      !contLastStepCalledTool &&
      (contFinishReason === undefined || contFinishReason === "stop") &&
      contFinalText.trim().length > 0 &&
      continuation.responseMessages !== undefined &&
      (await opts.correctAgain.shouldCorrect({ finalText: contFinalText }))
    ) {
      // Held text was never shown: it is simply not released. Text already
      // streamed (the correction called a tool before it) is cut from the
      // stored reply, with a separator before what follows.
      if (!heldText) {
        yield { type: "text-delta", id: "false-approval-correction", text: CORRECTION_SEPARATOR }
        streamedLength += CORRECTION_SEPARATOR.length
        opts.onRetractAgain?.({
          end: streamedLength,
          text: contFinalText + CORRECTION_SEPARATOR,
        })
      }
      const correctionMessages = await continuation.responseMessages
      let againFinish: unknown = null
      for await (const raw of opts.correctAgain.continueWith(responseMessages, correctionMessages)
        .fullStream) {
        if ((raw as Chunk).type === "finish") {
          againFinish = raw
          continue
        }
        yield raw
      }
      if (againFinish ?? heldContinuationFinish) yield againFinish ?? heldContinuationFinish
      return
    }
    if (heldText) {
      const keep = opts.keepContinuation?.({ text: continuationText, calledTool }) ?? true
      if (keep) {
        yield* heldText
      } else {
        // The first answer stays, with the platform's own line after it: the
        // stored reply is exactly what was streamed, so nothing is cut.
        opts.onRetract(null)
        const notice = opts.droppedNotice?.({ finalText, allText, toolOutputs }) ?? ""
        if (notice) yield { type: "text-delta", id: "announced-action-notice", text: notice }
      }
    }
    if (heldContinuationFinish) yield heldContinuationFinish
    return
  }
  if (heldFinish) yield heldFinish
}

/** `text` without the retracted characters, or unchanged when they are not where expected. */
export function retractFromText(text: string, r: Retraction): string {
  const start = r.end - r.text.length
  if (start < 0 || text.slice(start, r.end) !== r.text) return text
  return text.slice(0, start) + text.slice(r.end)
}

/**
 * The timeline without the retracted characters of its text entries, or
 * unchanged when its text does not hold them where expected (as `retractFromText`).
 */
export function retractFromTimeline(
  timeline: TurnTimelineEntry[],
  r: Retraction,
): TurnTimelineEntry[] {
  const start = r.end - r.text.length
  const streamed = timeline.map((e) => (e.kind === "text" ? e.text : "")).join("")
  if (start < 0 || streamed.slice(start, r.end) !== r.text) return timeline
  let offset = 0
  const out: TurnTimelineEntry[] = []
  for (const entry of timeline) {
    if (entry.kind !== "text") {
      out.push(entry)
      continue
    }
    const from = offset
    const to = offset + entry.text.length
    offset = to
    const cutFrom = Math.max(from, start)
    const cutTo = Math.min(to, r.end)
    if (cutFrom >= cutTo) {
      out.push(entry)
      continue
    }
    const kept = entry.text.slice(0, cutFrom - from) + entry.text.slice(cutTo - from)
    if (kept.length > 0) out.push({ ...entry, text: kept })
  }
  return out
}

/** Each step's text without the retracted characters, counted on their concatenation. */
export function retractFromSteps(steps: readonly string[], r: Retraction): string[] {
  const start = r.end - r.text.length
  if (start < 0 || steps.join("").slice(start, r.end) !== r.text) return [...steps]
  let offset = 0
  const out: string[] = []
  for (const step of steps) {
    const from = offset
    offset += step.length
    const cutFrom = Math.max(from, start)
    const cutTo = Math.min(offset, r.end)
    out.push(cutFrom >= cutTo ? step : step.slice(0, cutFrom - from) + step.slice(cutTo - from))
  }
  return out
}

/**
 * The turn's output without the retracted false text: the whole text, the
 * timeline, and the caller's final-step text (a suffix of the whole text).
 * A retraction counts the text as streamed. When the caller joined its steps
 * as paragraphs (`stepTexts`, reply-flatten.ts), the cut is made in the steps
 * and the reply joined again from them.
 */
export function retractTurnOutput(
  out: {
    text: string
    stepTexts?: readonly string[]
    timeline?: TurnTimelineEntry[]
    finalStepText?: string
  },
  r: Retraction,
): {
  text: string
  stepTexts?: readonly string[]
  timeline?: TurnTimelineEntry[]
  finalStepText?: string
} {
  const streamed = out.stepTexts ? out.stepTexts.join("") : out.text
  let finalStepText = out.finalStepText
  if (finalStepText !== undefined && streamed.endsWith(finalStepText)) {
    const suffixStart = streamed.length - finalStepText.length
    finalStepText = retractFromText(finalStepText, {
      end: r.end - suffixStart,
      text: r.text,
    })
  }
  const stepTexts = out.stepTexts ? retractFromSteps(out.stepTexts, r) : undefined
  return {
    text: stepTexts
      ? stepTexts.join("") === streamed
        ? out.text
        : replyTextOfSteps(stepTexts)
      : retractFromText(out.text, r),
    ...(stepTexts ? { stepTexts } : {}),
    ...(out.timeline ? { timeline: retractFromTimeline(out.timeline, r) } : {}),
    ...(finalStepText !== undefined ? { finalStepText } : {}),
  }
}
