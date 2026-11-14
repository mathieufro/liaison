// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE INPUT BUDGET OF ONE INTERACTIVE TURN.
//
// Every step of the agent loop sends the whole context again, so a turn costs
// about its step count times its context. Nothing bounded the step count of a
// chat turn below STEP_LIMIT (40) and the runaway cap (1.5M uncached tokens),
// both sized for long, legitimate analyses. On demo (2026-10-12) a one-word
// "yes" that landed in a conversation with nothing to confirm sent the agent
// searching: 18 steps, 17 tool calls, 550,000 input tokens for one answer.
//
// The budget is proportional to the turn's own opening context: a turn may
// send about TURN_BUDGET_OPENING_REREADS times what its first step sent, that
// is the old STEP_LIMIT (40) of steps at the opening size, and never less than
// TURN_BUDGET_FLOOR_TOKENS, so a normal long job (a monthly report: many
// kpi_run calls and gate-fix loops) finishes in one turn. Review 2026-10-12:
// the first cut (15x, floor 200,000) stopped a 50k-opening turn after about 12
// steps. Past the budget the turn is not cut off: the next step runs with tool
// calls switched off and a note asking the agent to say what it has done and
// found, what is left, and whether to go on. The person answers, and a long job
// goes on in the next turn with its history. Input is counted whole, cached
// part included, as the credit ledger and the demo ceiling count it.
//
// Only a PERSON's chat turn carries one. A routine tick has its own budget and
// hard limit (run-token-limit.ts); a turn another agent started (agents_ask,
// an agent's @mention) answers that agent, so a "should I continue?" would go
// to a caller that cannot say yes. The runaway cap still applies to every run.

/** How many times its opening context a turn may send before it must check in. */
export const TURN_BUDGET_OPENING_REREADS = 40

/** The budget is never below this, so a small opening context still gets room to work. */
export const TURN_BUDGET_FLOOR_TOKENS = 1_500_000

/** The note the check-in step carries. Plain words, no tool names. */
export const TURN_BUDGET_CHECK_IN_NOTE =
  "This turn has used its budget for this message. Do not call any more tools now. In a few sentences, tell the person what you have done and found so far, what is left to do, and ask whether you should continue."

type CheckInStep = {
  toolCalls?: ReadonlyArray<{ toolName?: string; toolCallId?: string; input?: unknown }>
  toolResults?: ReadonlyArray<{ toolCallId?: string; output?: unknown }>
}

/** Statuses a result gives for work that was asked for and refused: nothing was done. */
const REFUSED_STATUSES = new Set(["refused", "rejected", "denied", "not_run", "skipped"])
/** Statuses a result gives for work that started and has not finished yet. */
const STARTED_STATUSES = new Set([
  "started",
  "queued",
  "running",
  "in_progress",
  "dispatched",
  "scheduled",
])

/**
 * A gated call's parked answer: its own status, or a parked envelope inside its
 * result (`{ blocked: {...} }`, as false-approval-guard.ts reads it).
 */
function parked(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== "object" || depth > 4) return false
  const v = value as Record<string, unknown>
  if (depth === 0 && (v.status === "pending_approval" || v.blocked === true)) return true
  if (v.blocked !== null && typeof v.blocked === "object") return true
  if (v.blocked === true && v.status === "pending_approval") return true
  const children = Array.isArray(value) ? value : Object.values(v)
  return children.some((child) => parked(child, depth + 1))
}

/**
 * How one call of the turn ended, read from its result. A call that started
 * work (a session on a computer, a job) says it has not finished, and a status
 * the result names is passed on as it is, so the wrap-up claims no more than
 * the result shows.
 */
export function callOutcome(output: unknown): string {
  if (typeof output === "string" && output.startsWith("This call was not run")) return "was not run"
  const o = (output && typeof output === "object" ? output : {}) as Record<string, unknown>
  const value = (
    o.type === "json" && o.value && typeof o.value === "object" ? o.value : o
  ) as Record<string, unknown>
  if (parked(value)) return "waits for a person's approval"
  if ((value.error !== undefined && value.error !== null) || value.ok === false) return "failed"
  // A status word only (a record's own field could hold any text).
  const status =
    typeof value.status === "string" && /^[a-z_]{1,32}$/.test(value.status) ? value.status : null
  if (status && REFUSED_STATUSES.has(status)) return "was refused: nothing was done"
  if (status && STARTED_STATUSES.has(status)) return `started and has not finished (${status})`
  if (status && status !== "ok" && status !== "done" && status !== "success") {
    return `ran (its result says: ${status})`
  }
  return "ran"
}

/**
 * The facts the check-in step answers from: each tool the turn called and how it ended, read
 * from the turn's own tool results, so the true account ("what is done, what is left") is the
 * one at hand. Searches for tools are left out.
 */
export function checkInFacts(steps: ReadonlyArray<CheckInStep> | undefined): string {
  const lines: string[] = []
  for (const step of steps ?? []) {
    const outputs = new Map((step.toolResults ?? []).map((r) => [r.toolCallId, r.output]))
    for (const call of step.toolCalls ?? []) {
      const input = (call.input && typeof call.input === "object" ? call.input : {}) as {
        name?: unknown
      }
      const name =
        call.toolName === "kernel__call_tool" && typeof input.name === "string"
          ? input.name
          : call.toolName
      if (!name || name === "kernel__tool_search") continue
      lines.push(`${name} ${callOutcome(outputs.get(call.toolCallId))}`)
    }
  }
  return lines.length === 0
    ? "This turn called no tool: nothing was read, done or changed."
    : `What this turn's tool results show: ${lines.join("; ")}. Nothing else was done.`
}

/** What a tool call in the check-in step gets back: it was not run. */
export const TURN_BUDGET_ANSWER_ONLY_RESULT =
  "This call was not run: this turn has used its budget for this message, so this step answers in words. Tell the person what you have done and found so far, what is left to do, and ask whether you should continue."
/**
 * The note the last step that still has tools carries, on a turn with a step
 * budget. Without it a weak model spent every step reading and was then told,
 * tools off, to say how far it got: the turn ended in "shall I continue?" with
 * nothing written.
 */
export const TURN_BUDGET_LAST_TOOL_STEP_NOTE =
  "This is the last step of this turn in which you can call tools: the next step answers in words, and a tool called in it is not run. Do not call any more read, search or lookup tools. If the request asks you to write, draft, create or stage things, make every one of those calls now, in this step (one step can make several calls), with what you already know."

/** The system prompt line a turn with a step budget carries, so the model can plan its reads. */
export function stepBudgetPromptLine(maxSteps: number): string {
  return `This turn can take at most ${maxSteps} steps: ${maxSteps - 1} that can call tools, then one that answers in words. Read only what the request needs, several reads in one step where you can, and make the changes it asks for by step ${maxSteps - 1}.`
}

export interface TurnInputBudget {
  /** Adds one finished step's input tokens (cached included). */
  recordStep(inputTokens: number): void
  /** The budget, known once the first step has finished; null before. */
  readonly limit: number | null
  /** Input tokens the turn has sent so far. */
  readonly used: number
  /** True when the next step must be the check-in (budget reached, check-in not yet sent). */
  checkInDue(): boolean
  /**
   * True when the next step is the last one that may call tools (a step
   * budget only): it carries TURN_BUDGET_LAST_TOOL_STEP_NOTE.
   */
  lastToolStepDue(): boolean
  /** Marks the check-in step as sent; true from then on. */
  markCheckInSent(): void
  readonly checkInSent: boolean
  /**
   * The steps this turn may still take under its step budget (null without
   * one). Every model step of the turn counts: a resumed attempt's earlier
   * steps, a correction continuation's, and the check-in itself.
   */
  stepsLeft(): number | null
}

/** The budget for a turn whose first step sent `firstStepInputTokens`. */
export function turnInputBudgetFor(firstStepInputTokens: number): number {
  return Math.max(TURN_BUDGET_FLOOR_TOKENS, TURN_BUDGET_OPENING_REREADS * firstStepInputTokens)
}

/**
 * A turn's budget. `maxSteps` adds a step budget on top of the input budget:
 * the step numbered `maxSteps` (the last one) is the check-in, tools off, so a
 * turn that may take at most that many steps still ends with an answer rather
 * than being cut after a tool call. A demo visitor's turn carries one (its
 * steps are spent on this box's key, LIAISON_DEMO_STEPS_PER_TURN).
 */
export function createTurnInputBudget(opts: { maxSteps?: number } = {}): TurnInputBudget {
  let limit: number | null = null
  let used = 0
  let steps = 0
  let checkInSent = false
  const maxSteps = opts.maxSteps
  return {
    recordStep(inputTokens: number) {
      const n = Number.isFinite(inputTokens) && inputTokens > 0 ? Math.floor(inputTokens) : 0
      if (limit === null && n > 0) limit = turnInputBudgetFor(n)
      used += n
      steps += 1
    },
    get limit() {
      return limit
    },
    get used() {
      return used
    },
    checkInDue() {
      if (checkInSent) return false
      if (maxSteps !== undefined && steps >= Math.max(0, maxSteps - 1)) return true
      return limit !== null && used >= limit
    },
    lastToolStepDue() {
      if (checkInSent || maxSteps === undefined || maxSteps < 2) return false
      return steps === maxSteps - 2
    },
    markCheckInSent() {
      checkInSent = true
    },
    get checkInSent() {
      return checkInSent
    },
    stepsLeft() {
      return maxSteps === undefined ? null : Math.max(0, maxSteps - steps)
    },
  }
}
