// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A ROUTINE RUN WAITS FOR ITS APPROVALS, THEN CARRIES ON WITH THEIR RESULTS.
//
// A routine's gated call (a gated tool, a call held because the run read
// outside text, a host gate) parks as an approval. The run used to end right
// there: its summary went out saying something was pending, and when a person
// approved, the call ran and its result landed in the run's output thread with
// nobody to read it. A routine that needs a fetched page to fill in a CRM
// record never got to fill it in.
//
// Now the run waits, durably:
//
//   - PAUSE. When a tick's (or a resume's) turn ends and approvals it asked for
//     are still undecided, the run row says `waiting_approval` and keeps what
//     the resume needs in `pause_state` (0222): the approvals, the output
//     thread, the run line, the run's own prompt message, and what the run's
//     frame and thread carried that a turn is judged by: the outside sender of
//     the email that started it (the one home page it may read under taint),
//     its outside-text mark with that mark's sources, and its token account.
//     The resume puts each of them back, so the run goes on as it would have
//     without the wait. The run line in the
//     report conversation says the run waits for an approval. Nothing else
//     happens: no summary, no one-shot completion, no alert. The turn itself
//     stopped after the step that parked the call (agent-service.ts,
//     ROUTINE_RUN_PAUSE_NOTE), so it guessed nothing. The routine lock is
//     released: other ticks of the routine run meanwhile.
//
//   - RESUME TRIGGER. The same job that wakes a chat agent once its approval
//     is decided (approval-result-turn.ts: one job per approval, its
//     once-per-approval claim, its bundle rule). For an approval a routine run
//     asked for (`originRoutineRunId`, recorded by execute-tool.ts from the run
//     frame) that job, enqueued on approval and also on denial and expiry,
//     calls `resumeRoutineRunOnDecision` here. Only the last of the run's
//     approvals to be decided resumes it; every other one is a no-op. The pause
//     re-enqueues it for an approval decided before the row said it waits, and
//     the sweep (`sweepWaitingRoutineRuns`) for a job lost to a restart.
//
//   - RESUME. The job takes and renews the routine lock (a busy lock
//     re-enqueues it with a delay), claims the resume (once per run part: the
//     waited-on approvals move out of the row), re-checks the routine's scopes
//     against its owner and owner agent as a tick does, runs the
//     credit gate like any tick, and posts one message as the owner that
//     starts the next turn: the run's own prompt, what the run said at the
//     pause, and each decision as the platform's own line, an approved call's
//     output fenced as untrusted data (system-event-replay.ts, the lines an
//     interactive turn reads after an approval). The turn is metered like a
//     tick's. It may park another call: the run waits again, at most
//     MAX_ROUTINE_RUN_RESUMES times, then ends with a line saying so. A denied,
//     expired or withdrawn call resumes the run once, told it did not run,
//     and that resume is the run's last part (no retry loop).
//
//   - END. The run row takes its final status, the run line settles and the
//     summary is posted in the report conversation once, at the real end
//     (routine-worker.ts finishRun).
//
// Credits: the paused run holds nothing. The tick's turn settled its spend
// when it ended, and the resume asks the gate again, like a new tick.

import crypto from "node:crypto"
import { and, asc, sql as drizzleSql, eq, gte } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { approvalRequests, messages, routineRuns, routines } from "~/db/schema/kernel"
import type { RoutineRunPauseState } from "~/db/schema/kernel/routine-runs"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { rootLogger } from "~/lib/logger"
import { settleRunStarted } from "~/modules/agent/routines/routine-report"
import {
  acquireRoutineLock,
  emitRoutineEvent,
  finishRun,
  pauseRoutineForScopeGap,
  type RoutineRunTrigger,
  type RoutineTickOpts,
  type RoutineTickResult,
  releaseRoutineLock,
  routineRunScopes,
  routineScopeGap,
  startRoutineLockHeartbeat,
  writeRunRow,
} from "~/modules/agent/routines/routine-worker"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { continueRunTokenAccount } from "~/modules/agent/runtime/run-token-limit"
import { outsideTextSourceOf } from "~/modules/agent/scopes/taint"
import type { ApprovalResultTurnPayload } from "~/modules/approvals/approval-result-turn"
import type { ExecutionFailure } from "~/modules/approvals/cascade-fail"
import { claimApprovalTurnOnce } from "~/modules/approvals/event-data"
import { approvalResultRequiredScopes } from "~/modules/approvals/result-notice"
import {
  SKIPPED_MOVING,
  sweepSkippingMoving,
  writeUnlessMoving,
} from "~/modules/org/transfer-state/skip-moving"

const log = rootLogger.child({ module: "routine-run-resume" })
const K = drizzleSql.raw(schemaRef("kernel"))

export const MAX_ROUTINE_RUN_RESUMES = 5
/** The approval states a run still waits on. Every other state is decided. */
const UNDECIDED = new Set(["pending", "deferred", "approving"])
/** A resume that finds the routine busy (another tick) tries again after this. */
const LOCK_RETRY_DELAY_MS = 60_000
/** ...this many times (an hour), then the run ends. */
const MAX_LOCK_RETRIES = 60
/** What the run said at a pause, kept for the resume, per pause. */
const PROGRESS_CAP = 2_000

type RoutineRow = typeof routines.$inferSelect

/** A thread's outside-text mark: set or not, and its sources (null: one is unknown). */
interface TaintMark {
  tainted: boolean
  sources: string[] | null
}

/** Two marks as one: tainted when either is, its sources unknown when either's are. */
function mergeMarks(a: TaintMark, b: TaintMark): TaintMark {
  if (!a.tainted) return b
  if (!b.tainted) return a
  if (a.sources === null || b.sources === null) return { tainted: true, sources: null }
  return { tainted: true, sources: [...new Set([...a.sources, ...b.sources])] }
}

/** The mark a pause state kept. One kept before its sources were (no `taintedSources`): unknown. */
function keptMark(state: RoutineRunPauseState): TaintMark {
  return { tainted: state.tainted, sources: state.tainted ? (state.taintedSources ?? null) : null }
}

/** What resumes a run: the approval-result-turn job, for one decided approval of it. */
type ResumePayload = Pick<
  ApprovalResultTurnPayload,
  "orgId" | "approvalId" | "rerun" | "lockRetries"
>

interface RunApproval {
  id: string
  status: string
  handle: string | null
  tool_name: string
  /** The approved call's last execution state (approved_handler_executions), if it ran. */
  execution: string | null
  expires_at: string | null
  /** Set when its bundle (or the lone call) failed when it ran (cascade-fail.ts). */
  execution_failure: ExecutionFailure | null
}

/** Every approval a run asked for, by the run id its approvals record. */
async function approvalsOfRun(orgId: string, tickRunId: string): Promise<RunApproval[]> {
  return withPrivilegedDb(orgId, "routine-run-approvals", async (tx) =>
    extractRows<RunApproval>(
      await tx.execute(drizzleSql`
        SELECT a.id::text, a.status, a.handle, a.tool_name, a.expires_at::text,
               a.metadata->'executionFailure' AS execution_failure,
               (SELECT e.status FROM ${K}.approved_handler_executions e
                 WHERE e.approval_request_id = a.id AND e.org_id = a.org_id
                 ORDER BY e.last_attempt_at DESC NULLS LAST LIMIT 1) AS execution
          FROM ${K}.approval_requests a
         WHERE a.org_id = ${orgId}::uuid
           AND a.metadata->>'originRoutineRunId' = ${tickRunId}
         ORDER BY a.created_at`),
    ),
  )
}

/** How many of a run's approvals no person has decided yet. */
export async function undecidedApprovalCount(orgId: string, tickRunId: string): Promise<number> {
  return (await approvalsOfRun(orgId, tickRunId)).filter((a) => UNDECIDED.has(a.status)).length
}

/** The last thing the routine's agent wrote in the output thread since `since`. */
async function lastAgentText(
  orgId: string,
  threadId: string,
  ownerAgentId: string | null,
  since: Date,
): Promise<string> {
  const rows = await withPrivilegedDb(orgId, "routine-run-pause-progress", (tx) =>
    tx
      .select({ content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          eq(messages.orgId, orgId),
          eq(messages.authorType, "agent"),
          ownerAgentId ? eq(messages.authorAgentId, ownerAgentId) : undefined,
          gte(messages.createdAt, since),
        ),
      )
      .orderBy(asc(messages.createdAt)),
  )
  const last = [...rows].reverse().find((r) => r.content.trim().length > 0)
  return (last?.content ?? "").trim().slice(0, PROGRESS_CAP)
}

/** The run's own prompt message: the owner's first message in the output thread since it started. */
async function runPromptMessageId(
  orgId: string,
  threadId: string,
  ownerUserId: string,
  since: Date,
): Promise<string | null> {
  const [row] = await withPrivilegedDb(orgId, "routine-run-pause-prompt", (tx) =>
    tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          eq(messages.orgId, orgId),
          eq(messages.authorType, "user"),
          eq(messages.authorId, ownerUserId),
          gte(messages.createdAt, since),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(1),
  )
  return row?.id ?? null
}

/**
 * Pause a run whose turn left approvals undecided: the run row says
 * `waiting_approval`, its line says it waits, and nothing else ends. Returns
 * the tick's result, or null when the run waits on nothing (it ends as usual).
 *
 * `prior` is the pause state of a resumed run pausing again (its row exists).
 */
export async function pauseRunIfWaiting(args: {
  orgId: string
  routine: RoutineRow
  tickRunId: string
  outputThreadId: string
  recreated: boolean
  /** When the run started (ms). */
  startedAt: number
  /** When this part of the run started (ms): what it said since then is kept. */
  segmentStartedAt?: number
  runLineId: string | null
  turnsAdded: number
  trigger: RoutineRunTrigger
  tick?: Pick<RoutineTickOpts, "triggerEvent" | "requestUuid" | "requestedByUserId">
  prior?: { runId: string; state: RoutineRunPauseState }
  /** What the run's frame carried this part: kept for the next one. */
  runFrame?: Pick<RunContext, "tokenAccount">
}): Promise<RoutineTickResult | null> {
  const { orgId, routine } = args
  // A follow-up routine does not wait: its drafts stand on their own, each
  // decided when a person gets to it, and the run ends (routine-worker.ts).
  if (routine.followUp) return null
  const approvals = await approvalsOfRun(orgId, args.tickRunId)
  const waiting = approvals.filter((a) => UNDECIDED.has(a.status)).map((a) => a.id)
  if (waiting.length === 0) return null

  const segmentStart = new Date(args.segmentStartedAt ?? args.startedAt)
  const said = await lastAgentText(
    orgId,
    args.outputThreadId,
    routine.ownerAgentId ?? null,
    segmentStart,
  )
  const { readTaintMark } = await import("~/modules/agent/scopes/taint")
  const prior = args.prior?.state
  const mark = mergeMarks(
    await readTaintMark(args.outputThreadId, orgId),
    prior ? keptMark(prior) : { tainted: false, sources: null },
  )
  const account = args.runFrame?.tokenAccount
  const state: RoutineRunPauseState = {
    tickRunId: args.tickRunId,
    approvalIds: waiting,
    resumeCount: prior?.resumeCount ?? 0,
    outputThreadId: args.outputThreadId,
    runLineId: args.runLineId,
    startedAt: new Date(args.startedAt).toISOString(),
    tainted: mark.tainted,
    taintedSources: mark.sources,
    tokenAccount: account ? { id: account.id, used: account.used } : (prior?.tokenAccount ?? null),
    promptMessageId:
      prior?.promptMessageId ??
      (await runPromptMessageId(orgId, args.outputThreadId, routine.ownerUserId, segmentStart)),
    progress: [...(prior?.progress ?? []), ...(said ? [said] : [])],
    turnsAdded: args.turnsAdded,
    recreated: args.recreated,
    trigger: args.trigger,
    eventEntityId: prior?.eventEntityId ?? args.tick?.triggerEvent?.entityId ?? null,
    triggerEventId: prior?.triggerEventId ?? args.tick?.triggerEvent?.eventId ?? null,
    requestedByUserId: prior?.requestedByUserId ?? args.tick?.requestedByUserId ?? null,
  }

  let runId: string
  if (args.prior) {
    runId = args.prior.runId
    await withPrivilegedDb(orgId, "routine-run-pause-again", (tx) =>
      tx
        .update(routineRuns)
        .set({ status: "waiting_approval", pauseState: state, turnsAdded: args.turnsAdded })
        .where(and(eq(routineRuns.id, runId), eq(routineRuns.orgId, orgId))),
    )
  } else {
    runId = await writeRunRow(orgId, routine.id, "waiting_approval", {
      turnsAdded: args.turnsAdded,
      tick: args.tick,
      startedAt: new Date(args.startedAt),
      pauseState: state,
    })
  }
  await settleRunStarted(orgId, args.runLineId, "waiting_approval")
  await withPrivilegedDb(orgId, "routine-run-pause-last-run", (tx) =>
    tx
      .update(routines)
      .set({
        lastRunAt: new Date(),
        lastRunStatus: "waiting_approval",
        lastRunError: null,
        updatedAt: new Date(),
      })
      .where(eq(routines.id, routine.id)),
  )
  await emitRoutineEvent(orgId, routine.ownerUserId, routine.ownerAgentId, routine.id, "status", {
    status: routine.status,
    lastRunStatus: "waiting_approval",
    runId,
    ranAt: new Date().toISOString(),
  })
  log.info(
    { routineId: routine.id, runId, approvalIds: waiting, resumeCount: state.resumeCount },
    "routine run paused: it waits for its approvals",
  )
  // An approval decided between the turn's end and this row found no waiting
  // run to resume: resume now.
  await enqueueRerun(orgId, runId, state, `pause-${state.resumeCount}`)
  return { status: "waiting_approval", runId, durationMs: Date.now() - args.startedAt }
}

/** Whether every approval a waiting run waits on is decided (none while it resumes). */
async function allDecided(orgId: string, state: RoutineRunPauseState): Promise<boolean> {
  if (state.resumingAt || state.approvalIds.length === 0) return false
  const approvals = await approvalsOfRun(orgId, state.tickRunId)
  const byId = new Map(approvals.map((a) => [a.id, a.status]))
  return !state.approvalIds.some((id) => UNDECIDED.has(byId.get(id) ?? "pending"))
}

/**
 * Enqueue the decision job again for a run whose approvals are all decided but
 * that no job resumed: decided before the run row said it waits, or its job was
 * lost (a restart). `rerun` skips the per-approval claim, which that approval's
 * first job already took; the run's own claim still lets one resume through.
 */
async function enqueueRerun(
  orgId: string,
  runId: string,
  state: RoutineRunPauseState,
  tag: string,
): Promise<boolean> {
  if (!(await allDecided(orgId, state))) return false
  const approvalId = state.approvalIds[state.approvalIds.length - 1]!
  const { APPROVAL_RESULT_TURN_JOB } = await import("~/modules/approvals/approval-result-turn")
  try {
    await enqueueAppJob(
      "kernel",
      APPROVAL_RESULT_TURN_JOB,
      { ...(await decisionPayload(orgId, approvalId)), rerun: true },
      { jobId: `${APPROVAL_RESULT_TURN_JOB}:${approvalId}:${tag}`, attempts: 1 },
    )
    return true
  } catch (err) {
    log.error({ err, orgId, runId }, "routine run resume not enqueued")
    return false
  }
}

/** The decision job's payload for a routine run's approval. */
async function decisionPayload(orgId: string, approvalId: string) {
  const [row] = await withPrivilegedDb(orgId, "routine-run-decision-payload", async (tx) =>
    extractRows<{
      originating_thread_id: string
      requested_by: string
      agent_id: string | null
      routine_id: string
    }>(
      await tx.execute(drizzleSql`
        SELECT originating_thread_id::text, requested_by::text, agent_id::text,
               metadata->>'originRoutineId' AS routine_id
          FROM ${K}.approval_requests
         WHERE id = ${approvalId}::uuid AND org_id = ${orgId}::uuid`),
    ),
  )
  return {
    orgId,
    approvalId,
    threadId: row?.originating_thread_id ?? "",
    requesterId: row?.requested_by ?? "",
    agentId: row?.agent_id ?? "",
    routineId: row?.routine_id ?? "",
  } satisfies ApprovalResultTurnPayload
}

/** The waiting run an approval was asked for by, if it still waits. */
async function waitingRunOf(
  orgId: string,
  approvalId: string,
): Promise<{ id: string; routineId: string; pauseState: RoutineRunPauseState } | null> {
  const [row] = await withPrivilegedDb(orgId, "routine-run-waiting-lookup", async (tx) =>
    extractRows<{ id: string; routine_id: string; pause_state: RoutineRunPauseState }>(
      await tx.execute(drizzleSql`
        SELECT r.id::text, r.routine_id::text, r.pause_state
          FROM ${K}.approval_requests a
          JOIN ${K}.routine_runs r
            ON r.org_id = a.org_id
           AND r.routine_id::text = a.metadata->>'originRoutineId'
           AND r.pause_state->>'tickRunId' = a.metadata->>'originRoutineRunId'
         WHERE a.id = ${approvalId}::uuid AND a.org_id = ${orgId}::uuid
           AND r.status = 'waiting_approval'
         LIMIT 1`),
    ),
  )
  return row ? { id: row.id, routineId: row.routine_id, pauseState: row.pause_state } : null
}

// ---------------------------------------------------------------------------
// THE RESUME.
// ---------------------------------------------------------------------------

interface DecisionLines {
  lines: string[]
  /** The scopes of the rows quoted: the resume message is read under all of them. */
  requiredScopes: string[]
  /** A call that did not run: the run's next part is its last. */
  refused: boolean
  /** A call or bundle that failed when it ran, with no effect left to doubt: the run may propose a corrected one. */
  failed: boolean
  /** What the approved results marked the run with (outside text they read, and its sources). */
  mark: TaintMark
}

/** Each decided approval, as the platform's own lines in the output thread. */
async function decisionLines(
  orgId: string,
  state: RoutineRunPauseState,
  approvals: RunApproval[],
): Promise<DecisionLines> {
  const { systemEventLine } = await import("~/modules/agent/context/system-event-replay")
  const ids = state.resumedFrom ?? state.approvalIds
  const waitedOn = approvals.filter((a) => ids.includes(a.id))
  const rows = await withPrivilegedDb(orgId, "routine-run-resume-decisions", (tx) =>
    tx
      .select({
        content: messages.content,
        metadata: messages.metadata,
        requiredScopes: messages.requiredScopes,
      })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, state.outputThreadId),
          eq(messages.orgId, orgId),
          eq(messages.authorType, "system"),
          drizzleSql`${messages.metadata}->>'requestId' = ANY(${`{${ids.join(",")}}`}::text[])`,
          drizzleSql`${messages.metadata}->>'type' IN ('approval-decision', 'approval-result')`,
        ),
      )
      .orderBy(asc(messages.createdAt)),
  )
  const lines: string[] = []
  const requiredScopes = new Set<string>()
  let refused = false
  let mark: TaintMark = { tainted: false, sources: null }
  // Each failed bundle (or lone call that failed for good) is told once, step by step.
  const failures = new Map<string, ExecutionFailure>()
  for (const a of waitedOn) {
    if (a.execution_failure) {
      failures.set(
        a.execution_failure.bundleId ?? a.execution_failure.failedStepId,
        a.execution_failure,
      )
    }
  }
  for (const a of waitedOn) {
    const label = `approval request ${a.handle ?? a.id} (${a.tool_name})`
    // Part of a failure told below: an approved step keeps its result line, the rest is told there.
    const partOfFailure = a.execution_failure !== null
    // Approved, then its call failed when it ran: it ran, and has no result.
    const ranAndFailed =
      !partOfFailure &&
      (a.status === "failed" || a.execution === "failed_no_effect" || a.execution === "ambiguous")
    if (!partOfFailure && (a.status !== "approved" || ranAndFailed)) refused = true
    const own = rows.filter(
      (r) => (r.metadata as { requestId?: string } | null)?.requestId === a.id,
    )
    const rendered: string[] = []
    for (const r of own) {
      const line = systemEventLine({ content: r.content, metadata: r.metadata })
      if (!line) continue
      rendered.push(line)
      for (const s of r.requiredScopes ?? []) requiredScopes.add(s)
      const meta = r.metadata as { tainted?: unknown; toolName?: unknown } | null
      if (meta?.tainted === true) {
        // The source a live call of that tool names (approvals/result-notice.ts marks it so).
        const source = outsideTextSourceOf(typeof meta.toolName === "string" ? meta.toolName : null)
        mark = mergeMarks(mark, { tainted: true, sources: source ? [source] : null })
      }
    }
    if (partOfFailure) {
      // Told with its bundle below.
    } else if (ranAndFailed) {
      rendered.push(
        `[Event: ${label} was approved and ran, but the call FAILED: it has no result${a.execution === "ambiguous" ? " (it may have taken effect)" : ""}. Do not run it again in this run.]`,
      )
    } else if (a.status !== "approved") {
      rendered.push(
        `[Event: ${label} ended ${a.status}: the call did NOT run and has no result. Do not propose it again in this run.]`,
      )
    } else if (
      !own.some((r) => (r.metadata as { type?: string } | null)?.type === "approval-result")
    ) {
      rendered.push(`[Event: ${label} was approved and ran; it returned no output.]`)
    }
    lines.push(...rendered)
  }
  if (failures.size > 0) {
    const { describeBundleFailure } = await import("~/modules/approvals/cascade-fail")
    for (const failure of failures.values()) {
      const text = await withPrivilegedDb(orgId, "routine-run-resume-failure", (tx) =>
        describeBundleFailure(tx, orgId, failure),
      )
      lines.push(`[Event: ${text.replace(/\n/g, "\n  ")}]`)
    }
    // The failure text quotes the handler's error and the outputs of the steps
    // that ran. The platform's failure notices (cascade-fail.ts, decide.ts) fail
    // that closed to the requester's whole scope set, which a routine run's turn
    // (narrowed to the routine's effective scope) need not hold: posting the
    // resume under it hid the resume from the very turn it resumes, which then
    // ran on an empty history. So the resume is read under what each step's
    // result notice would demand (approvalResultRequiredScopes: the scopes of
    // the turn that proposed it, plus what the tool reads), as a step that ran
    // cleanly is. A step with no recorded proposing-turn scopes, or whose tool
    // is gone, keeps the notices' fail-closed stamp.
    const keys = [...failures.values()].flatMap((f) => [
      f.failedStepId,
      f.bundleId ?? f.failedStepId,
    ])
    const keyList = `{${keys.join(",")}}`
    const notices = await withPrivilegedDb(orgId, "routine-run-resume-failure-scopes", (tx) =>
      tx
        .select({ requiredScopes: messages.requiredScopes })
        .from(messages)
        .where(
          and(
            eq(messages.threadId, state.outputThreadId),
            eq(messages.orgId, orgId),
            eq(messages.authorType, "system"),
            drizzleSql`(
              (${messages.metadata}->>'type' = 'sequence-failed'
                AND ${messages.metadata}->>'bundleId' = ANY(${keyList}::text[]))
              OR (${messages.metadata}->>'type' = 'approval-error'
                AND ${messages.metadata}->>'requestId' = ANY(${keyList}::text[])))`,
          ),
        ),
    )
    const noticeScopes = [...new Set(notices.flatMap((n) => n.requiredScopes ?? []))]
    const steps = await withPrivilegedDb(orgId, "routine-run-resume-failure-steps", (tx) =>
      tx
        .select({
          toolName: approvalRequests.toolName,
          proposingTurnScopes: approvalRequests.proposingTurnScopes,
          requestedBy: approvalRequests.requestedBy,
        })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.orgId, orgId),
            drizzleSql`(${approvalRequests.id}::text = ANY(${keyList}::text[])
              OR ${approvalRequests.bundleId}::text = ANY(${keyList}::text[]))`,
          ),
        ),
    )
    // No notice found (posted elsewhere, or not yet): fail closed to the
    // requester's whole scope set, as the notices themselves are stamped.
    let requesterScopes = noticeScopes
    const requester = steps[0]?.requestedBy
    if (requesterScopes.length === 0 && requester) {
      const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
      requesterScopes = await withPrivilegedDb(
        orgId,
        "routine-run-resume-failure-requester",
        async (tx) => (await loadEffectivePermissions(tx, requester, orgId)).scopes,
      )
    }
    const narrowed =
      requesterScopes.length > 0 &&
      steps.length > 0 &&
      steps.every((r) => Array.isArray(r.proposingTurnScopes))
    if (narrowed) {
      for (const r of steps) {
        for (const sc of approvalResultRequiredScopes({
          orgId,
          toolName: r.toolName,
          proposingTurnScopes: r.proposingTurnScopes,
          requesterScopes,
        }))
          requiredScopes.add(sc)
      }
    } else {
      for (const sc of requesterScopes) requiredScopes.add(sc)
    }
  }
  return { lines, requiredScopes: [...requiredScopes], refused, failed: failures.size > 0, mark }
}

/** The message that starts a resumed run's next turn. */
function resumeContent(args: {
  prompt: string | null
  progress: string[]
  decisions: string[]
  last: boolean
  /** A call or sequence below failed when it ran. */
  failed?: boolean
  /** The run may not wait for another approval (MAX_ROUTINE_RUN_RESUMES). */
  capReached?: boolean
}): string {
  const parts = [
    "[ROUTINE RUN RESUMED: this run paused for the approval request(s) below, and they are now decided. Carry on with the routine's task from where the run stopped, using their results. Do not repeat calls that already ran, and do not propose a refused call again.]",
  ]
  if (args.failed && !args.last) {
    parts.push(
      "[A call or sequence below FAILED when it ran. It is closed and cannot be retried. Read its error, then propose a corrected call or sequence as NEW tool calls in this run (change what the error names; do not repeat the steps that already ran). A person approves it again, and the run carries on once it is decided.]",
    )
  } else if (args.failed && args.capReached) {
    parts.push(
      `[A call or sequence below FAILED when it ran, and this run cannot propose a corrected one: it has already waited for approvals ${MAX_ROUTINE_RUN_RESUMES} times, the most a run may. Do not make new gated calls. End with the run's final summary naming the failed tool, its error, what to change, and the steps that did not run, so a person (or the next run) can finish it.]`,
    )
  }
  if (args.last) {
    parts.push(
      "[This is the run's last part: finish the task with what you have, and end with the run's final summary.]",
    )
  }
  if (args.prompt) parts.push(`The task this run started with:\n\n${args.prompt}`)
  if (args.progress.length > 0) {
    parts.push(
      `What you wrote when the run paused:\n\n${args.progress.map((p) => `> ${p.replace(/\n/g, "\n> ")}`).join("\n\n")}`,
    )
  }
  parts.push(`The decisions:\n\n${args.decisions.join("\n")}`)
  return parts.join("\n\n")
}

/** What a resume's turn is handed (tests inject their own). */
export interface ResumeInvokerInput {
  orgId: string
  routineId: string
  ownerUserId: string
  threadId: string
  content: string
  scopes: string[]
  /** Scopes of what the message quotes: it is read under them too. */
  extraRequiredScopes: string[]
  /** Whether the run had read outside text: the thread is marked so before the turn. */
  tainted: boolean
  /** The sources of that outside text (null: one is unknown), as the mark names them. */
  taintedSources: string[] | null
}

export type ResumeInvoker = (
  input: ResumeInvokerInput,
) => Promise<{ turnsAdded: number; failure?: string | null }>

export interface ResumeDeps {
  invoker?: ResumeInvoker
  checkCredits?: (orgId: string, userId: string) => Promise<{ reason: string } | null>
  loadOwnerScopes?: (orgId: string, userId: string) => Promise<string[]>
}

/**
 * A routine run's approval was decided (approval-result-turn.ts, the job every
 * decided agent approval takes): resume the run it belongs to, when that run
 * waits and this was the last of its approvals to be decided. Every other
 * decided approval of the run is a no-op here. Returns whether the run resumed.
 */
export async function resumeRoutineRunOnDecision(
  payload: ResumePayload,
  deps: ResumeDeps = {},
): Promise<RoutineTickResult | { status: "no_run" | "lock_busy" }> {
  const { orgId, approvalId } = payload
  const run = await waitingRunOf(orgId, approvalId)
  if (!run) return { status: "no_run" }

  const lock = await acquireRoutineLock(run.routineId)
  if (!lock) {
    // Another run of the routine holds it: this decision's job comes back later,
    // its per-approval claim untouched.
    const retries = (payload.lockRetries ?? 0) + 1
    if (retries <= MAX_LOCK_RETRIES) {
      const { APPROVAL_RESULT_TURN_JOB } = await import("~/modules/approvals/approval-result-turn")
      await enqueueAppJob(
        "kernel",
        APPROVAL_RESULT_TURN_JOB,
        { ...(await decisionPayload(orgId, approvalId)), ...payload, lockRetries: retries },
        {
          jobId: `${APPROVAL_RESULT_TURN_JOB}:${approvalId}:lock-${retries}${payload.rerun ? "-rerun" : ""}`,
          attempts: 1,
          delay: LOCK_RETRY_DELAY_MS,
        },
      )
      return { status: "lock_busy" }
    }
    log.error({ orgId, runId: run.id }, "routine run could not resume: its routine stayed busy")
  }
  // The resumed turn may run as long as a tick: the lock is kept alive as a tick keeps it.
  const stopHeartbeat = lock ? startRoutineLockHeartbeat(run.routineId) : () => {}
  try {
    // Once per approval, the claim the chat path takes (event-data.ts): a
    // replayed or re-enqueued job for this approval does nothing.
    if (!payload.rerun && !(await claimApprovalTurnOnce(orgId, approvalId))) {
      return { status: "no_run" }
    }
    const current = await waitingRunOf(orgId, approvalId)
    if (!current || !(await allDecided(orgId, current.pauseState))) return { status: "no_run" }
    return await resumeUnderLock(
      orgId,
      current.id,
      current.pauseState.resumeCount,
      run.routineId,
      deps,
      lock !== null,
    )
  } finally {
    stopHeartbeat()
    if (lock) await releaseRoutineLock(run.routineId, lock)
  }
}

/**
 * Claim a waiting run's resume, once: the resume count moves on, the waited-on
 * approvals move to `resumedFrom` and `resumingAt` is set, so neither a late
 * event for one of them nor a second job starts another resume. The pause
 * state as claimed, or null when the run was claimed or ended before.
 */
async function claimResume(
  orgId: string,
  runId: string,
  resumeCount: number,
): Promise<RoutineRunPauseState | null> {
  const [claimed] = await withPrivilegedDb(orgId, "routine-run-resume-claim", async (tx) =>
    extractRows<{ pause_state: RoutineRunPauseState }>(
      await tx.execute(drizzleSql`
        UPDATE ${K}.routine_runs
           SET pause_state = pause_state || jsonb_build_object(
                 'resumeCount', ${resumeCount + 1}::int,
                 'resumedFrom', pause_state->'approvalIds',
                 'approvalIds', '[]'::jsonb,
                 'resumingAt', to_jsonb(now()))
         WHERE id = ${runId}::uuid AND org_id = ${orgId}::uuid
           AND status = 'waiting_approval'
           AND (pause_state->>'resumeCount')::int = ${resumeCount}
           AND pause_state->>'resumingAt' IS NULL
        RETURNING pause_state`),
    ),
  )
  return claimed?.pause_state ?? null
}

async function resumeUnderLock(
  orgId: string,
  runId: string,
  resumeCount: number,
  routineId: string,
  deps: ResumeDeps,
  locked: boolean,
): Promise<RoutineTickResult | { status: "no_run" }> {
  const claimed = await claimResume(orgId, runId, resumeCount)
  if (!claimed) return { status: "no_run" }
  // A tour step waiting on this routine now reads it working again
  // (modules/tours/beat-status.ts reads `resumingAt`): tell the org's runs.
  const { nudgeActiveTours } = await import("~/modules/tours/beat-status")
  await nudgeActiveTours(orgId).catch((err) =>
    log.warn({ err, runId }, "Could not nudge tour runs on a routine run resume"),
  )
  const state = claimed
  const [routine] = await withPrivilegedDb(orgId, "routine-run-resume-routine", (tx) =>
    tx
      .select()
      .from(routines)
      .where(and(eq(routines.id, routineId), eq(routines.orgId, orgId)))
      .limit(1),
  )
  if (!routine) return { status: "no_run" }

  const startedAt = Date.parse(state.startedAt)
  const end = async (agentError: string | null, turnsAdded: number, reportSince: number) => {
    // A run made a follow-up while it waited ends now: its line counts what still waits.
    const draftsWaiting =
      routine.followUp && agentError === null
        ? await undecidedApprovalCount(orgId, state.tickRunId)
        : 0
    return finishRun({
      orgId,
      routine,
      outputThreadId: state.outputThreadId,
      recreated: state.recreated ?? false,
      startedAt,
      runLineId: state.runLineId,
      ownerScopes,
      agentError,
      turnsAdded,
      requestedByUserId: state.requestedByUserId ?? undefined,
      trigger: state.trigger ?? "schedule",
      eventEntityId: state.eventEntityId ?? null,
      eventId: null,
      runId,
      reportSince,
      ...(draftsWaiting > 0 ? { draftsWaiting } : {}),
    })
  }

  const loadScopes = deps.loadOwnerScopes ?? defaultLoadOwnerScopes
  const ownerScopes = await loadScopes(orgId, routine.ownerUserId)
  const priorTurns = state.turnsAdded ?? 0
  if (!locked) {
    return end("The run could not resume: its routine stayed busy.", priorTurns, Date.now())
  }
  if (!routine.enabled || routine.status !== "active") {
    return end(
      "The run did not resume: the routine was switched off or paused while it waited for an approval.",
      priorTurns,
      Date.now(),
    )
  }
  // The same checks a tick makes: the owner may have lost a scope the routine
  // needs while the run waited, or its agent's ceiling may no longer cover it.
  const scopeGap = await routineScopeGap(orgId, routine, ownerScopes)
  if (scopeGap) {
    await pauseRoutineForScopeGap(orgId, routine, scopeGap)
    return end(`The run did not resume. ${scopeGap}`, priorTurns, Date.now())
  }
  const credit = deps.checkCredits ?? defaultCheckCredits
  const refusal = await credit(orgId, routine.ownerUserId)
  if (refusal) return end(refusal.reason, priorTurns, Date.now())

  const approvals = await approvalsOfRun(orgId, state.tickRunId)
  const decisions = await decisionLines(orgId, state, approvals)
  // The claim already counted this resume.
  const resumeNumber = state.resumeCount
  const capReached = resumeNumber >= MAX_ROUTINE_RUN_RESUMES
  const last = decisions.refused || capReached
  const prompt = await promptOf(orgId, state.promptMessageId ?? null)
  const content = resumeContent({
    prompt: prompt?.content ?? null,
    progress: state.progress ?? [],
    decisions: decisions.lines,
    last,
    failed: decisions.failed,
    capReached,
  })

  await settleRunStarted(orgId, state.runLineId, "running")
  const segmentStartedAt = await dbClockMs(orgId)
  let agentError: string | null = null
  let turnsAdded = priorTurns
  // The run's frame as the tick had it: the same token account.
  const tokenAccount = await continueRunTokenAccount(routine, state.tokenAccount)
  const mark = mergeMarks(keptMark(state), decisions.mark)
  try {
    const invoker = deps.invoker ?? defaultResumeInvoker
    const frameRunId = crypto.randomUUID()
    const result = await runContextStore.run(
      {
        runId: frameRunId,
        parentRunId: null,
        rootRunId: frameRunId,
        nestingDepth: 0,
        background: true,
        routineId: routine.id,
        routineRunId: state.tickRunId,
        // Made a follow-up while this run waited: it runs on and ends now.
        ...(routine.followUp ? { routineFollowUp: true } : {}),
        ...(tokenAccount ? { tokenAccount } : {}),
      },
      () =>
        invoker({
          orgId,
          routineId: routine.id,
          ownerUserId: routine.ownerUserId,
          threadId: state.outputThreadId,
          content,
          // The scopes the tick ran under (routine-worker.ts, routineRunScopes).
          scopes: routineRunScopes(routine.scopes ?? [], ownerScopes),
          extraRequiredScopes: [...decisions.requiredScopes, ...(prompt?.requiredScopes ?? [])],
          tainted: mark.tainted,
          taintedSources: mark.sources,
        }),
    )
    turnsAdded += result.turnsAdded
    if (result.failure) agentError = result.failure
  } catch (err) {
    agentError = err instanceof Error ? err.message : String(err)
  }

  // A turn that, waiting, wrote "Blocked: ..." waits too (routine-worker.ts).
  if (agentError === null || agentError.startsWith("The run reported itself blocked")) {
    if (!last) {
      const paused = await pauseRunIfWaiting({
        orgId,
        routine,
        tickRunId: state.tickRunId,
        outputThreadId: state.outputThreadId,
        recreated: state.recreated ?? false,
        startedAt,
        segmentStartedAt,
        runLineId: state.runLineId,
        turnsAdded,
        trigger: state.trigger ?? "schedule",
        prior: { runId, state },
        runFrame: { tokenAccount },
      })
      if (paused) return paused
    } else if (!decisions.refused) {
      // The cap: the run asked for approvals again after its last resume.
      const again = (await approvalsOfRun(orgId, state.tickRunId)).filter((a) =>
        UNDECIDED.has(a.status),
      )
      if (again.length > 0) {
        agentError = `The run stopped after waiting for approvals ${MAX_ROUTINE_RUN_RESUMES} times; its last requests (${again.map((a) => a.handle ?? a.id).join(", ")}) are still pending and their results will not be used by this run.`
      }
    }
  }
  return end(agentError, turnsAdded, segmentStartedAt)
}

/**
 * The database's clock, in ms. What the resumed turn says is kept by comparing
 * its rows' `created_at` (the database's clock) with this, so it is read there:
 * the host's clock may run a few ms ahead, and the turn's reply would be dropped.
 */
async function dbClockMs(orgId: string): Promise<number> {
  const [row] = await withPrivilegedDb(orgId, "routine-run-segment-start", async (tx) =>
    extractRows<{ ms: string }>(
      await tx.execute(
        drizzleSql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS ms`,
      ),
    ),
  )
  return Number(row!.ms)
}

async function promptOf(
  orgId: string,
  messageId: string | null,
): Promise<{ content: string; requiredScopes: string[] } | null> {
  if (!messageId) return null
  const [row] = await withPrivilegedDb(orgId, "routine-run-resume-prompt", (tx) =>
    tx
      .select({ content: messages.content, requiredScopes: messages.requiredScopes })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.orgId, orgId)))
      .limit(1),
  )
  return row ? { content: row.content, requiredScopes: row.requiredScopes ?? [] } : null
}

async function defaultLoadOwnerScopes(orgId: string, userId: string): Promise<string[]> {
  const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
  return withPrivilegedDb(orgId, "routine-perms", async (tx) => {
    const perms = await loadEffectivePermissions(tx, userId, orgId)
    return perms.scopes
  })
}

async function defaultCheckCredits(orgId: string): Promise<{ reason: string } | null> {
  const { routineTickCreditGate } = await import("~/infra/jobs/kernel-jobs")
  return routineTickCreditGate(orgId)
}

/**
 * The resumed turn, as a tick's turn runs: as the routine's owner under the
 * owner's dimension grants, at the tick's resolved scope, driven by the
 * routine supervisor and metered like any tick's turn, off one message the
 * owner posts in the output thread. The thread is marked as having read
 * outside text first when the run had, with the sources it had, so an outward
 * action after it parks exactly as it would have in the run's first part.
 */
const defaultResumeInvoker: ResumeInvoker = async (input) => {
  const { orgId, ownerUserId, threadId, scopes, routineId } = input
  const { withRlsContext } = await import("~/db/rls")
  const { sendMessage } = await import("~/modules/threads/message")
  const { invokeAgentForThread, resolveTurnScope } = await import(
    "~/modules/agent/runtime/agent-service"
  )
  const { runRoutineSupervisor } = await import("~/modules/agent/routines/routine-supervisor")
  const { seedRoutineTickTools } = await import("~/modules/agent/routines/routine-tool-seed")
  const { judgeRoutineTick } = await import("~/modules/agent/routines/routine-tick-outcome")
  const { restoreTaintMark } = await import("~/modules/agent/scopes/taint")
  const { ROUTINE_SUPERVISOR_POLICY, resolveRoutineOwnerDimensionGrants, routineCreditGate } =
    await import("~/infra/jobs/kernel-jobs")

  await restoreTaintMark(threadId, orgId, { tainted: input.tainted, sources: input.taintedSources })
  const dimensionGrants = await resolveRoutineOwnerDimensionGrants(orgId, ownerUserId)
  const turn = await withPrivilegedDb(orgId, "routine-resume-scope", (tx) =>
    resolveTurnScope(tx, orgId, threadId, { userId: ownerUserId, scopes }, routineId),
  )
  const requiredScopes = [
    ...new Set([...(turn ? turn.effectiveScope : scopes), ...input.extraRequiredScopes]),
  ].sort()
  const startedAt = new Date()
  let messageId = ""
  await withRlsContext(
    { actorType: "user", userId: ownerUserId, orgId, scopes, dimensionGrants },
    async (tx) => {
      const msg = await sendMessage(tx, {
        requiredScopes,
        threadId,
        userId: ownerUserId,
        orgId,
        content: input.content,
        agentId: turn?.agentId ?? null,
      })
      if (!msg) throw new Error(`Routine resume: owner ${ownerUserId} is not in thread ${threadId}`)
      messageId = msg.id
    },
  )
  const discovered = seedRoutineTickTools(
    orgId,
    { actorType: "user", userId: ownerUserId, orgId, scopes, dimensionGrants },
    scopes,
  )
  const res = await runRoutineSupervisor({
    invokeTurn: ({ perTurnBudget }) =>
      invokeAgentForThread(
        threadId,
        messageId,
        { userId: ownerUserId, orgId, scopes, dimensionGrants },
        orgId,
        true,
        perTurnBudget,
        routineId,
        discovered,
      ),
    checkCredits: () => routineCreditGate(orgId),
    now: () => Date.now(),
    policy: ROUTINE_SUPERVISOR_POLICY,
  })
  let failure: string | null = null
  try {
    failure = await judgeRoutineTick(orgId, threadId, startedAt)
  } catch (err) {
    log.error({ err, routineId }, "resumed routine run outcome could not be judged")
  }
  return { turnsAdded: res.turnsAdded, failure }
}

// ---------------------------------------------------------------------------
// THE SWEEP: no run waits forever.
// ---------------------------------------------------------------------------

/** A run whose approvals are all decided and that nothing resumed this long gets its job again. */
export const UNRESUMED_AFTER_MS = 10 * 60 * 1000
/** A resume that claimed a run and has not paused or ended it this long died (a restart). */
export const DEAD_RESUME_AFTER_MS = 30 * 60 * 1000
/** An approval past its expiry by this much was missed by the expiry sweep: the run ends. */
const EXPIRED_GRACE_MS = 60 * 60 * 1000
/** Runs the sweep reads per query. */
const SWEEP_PAGE = 200

/**
 * Every run that waits on approvals, judged (with the event reconciler's pass,
 * kernel-jobs.ts): one whose approvals are all decided but that no job resumed
 * past {@link UNRESUMED_AFTER_MS} gets its decision job again; one whose resume
 * died, or whose undecided approvals are long past their expiry, ends failed
 * with a line saying why.
 */
export async function sweepWaitingRoutineRuns(
  now: Date = new Date(),
): Promise<{ resumed: number; ended: number }> {
  const { withSystemDb } = await import("~/db/privileged")
  const deadBefore = new Date(now.getTime() - DEAD_RESUME_AFTER_MS).toISOString()
  const unresumedBefore = new Date(now.getTime() - UNRESUMED_AFTER_MS).toISOString()
  const lapsedBefore = new Date(now.getTime() - EXPIRED_GRACE_MS).toISOString()
  // An org being moved keeps its routines and runs as they are until the move ends.
  let resumed = 0
  let ended = 0
  // Oldest first, a page at a time; only the runs that need something come back.
  let cursor: { at: string; id: string } = {
    at: "-infinity",
    id: "00000000-0000-0000-0000-000000000000",
  }
  for (;;) {
    const page = await sweepSkippingMoving((notMoving) =>
      withSystemDb("routine-run-waiting-sweep", async (db) =>
        extractRows<{
          org_id: string
          id: string
          routine_id: string
          ran_at: string
          pause_state: RoutineRunPauseState
          verdict: "dead" | "decided" | "lapsed"
          lapsed: string | null
        }>(
          await db.execute(drizzleSql`
          SELECT * FROM (
            SELECT r.org_id::text, r.id::text, r.routine_id::text, r.ran_at::text, r.pause_state,
              CASE
                WHEN r.pause_state->>'resumingAt' IS NOT NULL THEN
                  CASE WHEN (r.pause_state->>'resumingAt')::timestamptz < ${deadBefore}::timestamptz
                    THEN 'dead' END
                WHEN r.ran_at >= ${unresumedBefore}::timestamptz THEN NULL
                WHEN jsonb_array_length(COALESCE(r.pause_state->'approvalIds', '[]'::jsonb)) > 0
                  AND NOT EXISTS (
                    SELECT 1 FROM ${K}.approval_requests a
                     WHERE a.org_id = r.org_id
                       AND a.id::text IN (SELECT jsonb_array_elements_text(r.pause_state->'approvalIds'))
                       AND a.status IN ('pending', 'deferred', 'approving'))
                  THEN 'decided'
                WHEN EXISTS (
                    SELECT 1 FROM ${K}.approval_requests a
                     WHERE a.org_id = r.org_id
                       AND a.id::text IN (SELECT jsonb_array_elements_text(r.pause_state->'approvalIds'))
                       AND a.status IN ('pending', 'deferred', 'approving')
                       AND a.expires_at < ${lapsedBefore}::timestamptz)
                  THEN 'lapsed'
              END AS verdict,
              (SELECT string_agg(COALESCE(a.handle, a.id::text), ', ')
                 FROM ${K}.approval_requests a
                WHERE a.org_id = r.org_id
                  AND a.id::text IN (SELECT jsonb_array_elements_text(r.pause_state->'approvalIds'))
                  AND a.status IN ('pending', 'deferred', 'approving')
                  AND a.expires_at < ${lapsedBefore}::timestamptz) AS lapsed
              FROM ${K}.routine_runs r
             WHERE r.status = 'waiting_approval' AND r.pause_state IS NOT NULL
               AND ${notMoving(drizzleSql.raw("r.org_id"))}
               AND (r.ran_at, r.id) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)
          ) v
          WHERE v.verdict IS NOT NULL
          ORDER BY v.ran_at, v.id
          LIMIT ${SWEEP_PAGE}`),
        ),
      ),
    )
    for (const r of page) {
      try {
        if (r.verdict === "decided") {
          const tag = `sweep-${r.pause_state.resumeCount}-${now.getTime()}`
          const queued = await writeUnlessMoving(r.org_id, () =>
            enqueueRerun(r.org_id, r.id, r.pause_state, tag),
          )
          if (queued !== SKIPPED_MOVING && queued) resumed++
          continue
        }
        const error =
          r.verdict === "dead"
            ? "The run stopped while it carried on after an approval, and did not finish."
            : `The run ended: the approval it waited for (${r.lapsed ?? "unknown"}) expired without a decision.`
        const didEnd = await writeUnlessMoving(r.org_id, () =>
          endWaitingRun(r.org_id, r.routine_id, r.id, error),
        )
        if (didEnd !== SKIPPED_MOVING && didEnd) ended++
      } catch (err) {
        log.error({ err, orgId: r.org_id, runId: r.id }, "waiting routine run not swept")
      }
    }
    if (page.length < SWEEP_PAGE) break
    const last = page[page.length - 1]!
    cursor = { at: last.ran_at, id: last.id }
  }
  return { resumed, ended }
}

/** End a waiting run failed, under its routine's lock (skipped while another run holds it). */
async function endWaitingRun(
  orgId: string,
  routineId: string,
  runId: string,
  error: string,
): Promise<boolean> {
  const lock = await acquireRoutineLock(routineId)
  // A live resume holds the lock (and renews it): never end a run under it.
  if (!lock) return false
  try {
    // Read under the lock: a resume that just ended the run left nothing to end.
    const [run] = await withPrivilegedDb(orgId, "routine-run-end-waiting", (tx) =>
      tx
        .select({ pauseState: routineRuns.pauseState })
        .from(routineRuns)
        .where(
          and(
            eq(routineRuns.id, runId),
            eq(routineRuns.orgId, orgId),
            eq(routineRuns.status, "waiting_approval"),
          ),
        )
        .limit(1),
    )
    if (!run?.pauseState) return false
    const [routine] = await withPrivilegedDb(orgId, "routine-run-end-waiting-routine", (tx) =>
      tx
        .select()
        .from(routines)
        .where(and(eq(routines.id, routineId), eq(routines.orgId, orgId)))
        .limit(1),
    )
    if (!routine) return false
    const state = run.pauseState
    const ended = await finishRun({
      orgId,
      routine,
      outputThreadId: state.outputThreadId,
      recreated: state.recreated ?? false,
      startedAt: Date.parse(state.startedAt),
      runLineId: state.runLineId,
      ownerScopes: [],
      agentError: error,
      turnsAdded: state.turnsAdded ?? 0,
      requestedByUserId: state.requestedByUserId ?? undefined,
      trigger: state.trigger ?? "schedule",
      eventEntityId: state.eventEntityId ?? null,
      eventId: null,
      runId,
    })
    return ended.status !== "no_run"
  } finally {
    await releaseRoutineLock(routineId, lock)
  }
}
