// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Routine worker — the per-tick state machine for kernel.routines.
 *
 * Entry point: `runRoutineTick(opts)` — called by:
 *   1. The BullMQ `kernel:routine-tick` worker (boot-registered in
 *      `kernel-jobs.ts`; consumes scheduled + manual run-now jobs).
 *   2. Tests that exercise the per-tick state machine directly.
 *
 * Lifecycle (one tick):
 *   - Acquire `routine-lock:<id>` via Redis SET NX EX 600. If lost → write
 *     a `skipped_overlap` run row and return — unless `deferOnOverlap` is set
 *     (event-fired ticks), which returns `lock_busy` so the job layer can
 *     re-enqueue the tick with a delay instead of dropping the event.
 *   - Heartbeat the lock every 5 min so long agent runs don't release early.
 *   - Load the routine; orphan → remove the scheduler + return.
 *   - Skip on `enabled=false` or a status other than `active`, and say so: a
 *     log line (never a silent skip). A routine the system paused is the
 *     exception: a credit pause re-runs the credit check, a scope pause the
 *     scope check, and the tick resumes it when the cause cleared (credits
 *     topped up, a model key added, a demo visitor's email confirmed, the
 *     scope given back, the owner reactivated).
 *   - Check the owner is active and scope drift (owner permissions ⊇
 *     routine.scopes); if not, mark `paused_scope_mismatch` and write a
 *     `skipped_scope_mismatch` run row.
 *   - Check the OWNER AGENT's ceiling is not empty; if it is, same treatment:
 *     the tick would run with an empty tool catalog (see `ownerAgentCeiling`).
 *   - Plan where the run happens (runs_on, A57): a node run skips the next
 *     step, since it runs on its owner's own Claude sign-in.
 *   - Check credit availability via `creditMeter.preCheck` for a cloud run;
 *     if denied, write a `skipped_no_credits` run row and, when the org is out
 *     of credits, mark `paused_no_credits` (a `node_else_cloud` run with no live
 *     node included: it does not fall back, and no `fell_back` job is
 *     recorded). A refusal that is not the org running out (a demo visitor's
 *     gate: "confirm your email", a per-visitor budget) skips the tick and
 *     leaves the routine active.
 *   - Ensure an output thread exists (create if missing).
 *   - Invoke the agent (or the injected stub) with the routine.prompt.
 *   - A successful run of a routine with a report conversation posts its
 *     final reply there (routine-report.ts).
 *   - Write a `succeeded` / `failed` / `output_thread_recreated` run row +
 *     update routine.lastRun* fields.
 *   - Release the lock (only if we still own the token).
 *
 * The agent invocation is injected via `opts.agentInvoker` so the worker is
 * unit-testable without the full agent runtime. The kernel-jobs wiring uses
 * `defaultAgentInvoker` which calls `sendMessage` + `invokeAgentForThread`.
 */
import crypto from "node:crypto"
import { and, eq, inArray, isNotNull } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import {
  agents as agentsTbl,
  routineRuns,
  routines,
  threadParticipants,
  threads,
  users,
  userThreadState,
} from "~/db/schema/kernel"
import type {
  RoutineRunFlowContext,
  RoutineRunPauseState,
  RoutineRunStepState,
} from "~/db/schema/kernel/routine-runs"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { removeScheduledJob } from "~/infra/jobs/jobs"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { routineMailboxReader } from "~/modules/agent/mailbox-plaintext/routine-mailbox-trust"
import { isAppRunRoutine } from "~/modules/agent/routines/kernel-routine-templates"
import {
  queueRoutineAlert,
  type RoutineAlertRoutine,
  routineOwnerInactiveReason,
} from "~/modules/agent/routines/routine-alert"
import { routineDisplayName } from "~/modules/agent/routines/routine-label"
import {
  deliverRoutineReport,
  postRunStarted,
  settleRunStarted,
  withReportSentence,
} from "~/modules/agent/routines/routine-report"
import { type MailboxHandoff, runContextStore } from "~/modules/agent/runtime/run-context"
import {
  createRunTokenAccount,
  withTokenBudgetSentence,
} from "~/modules/agent/runtime/run-token-limit"
import { isScopeCovered } from "~/modules/agent/scopes/scope-coverage"
import type { RoutineRunPlan } from "~/modules/nodes/routine-dispatch"

const log = rootLogger.child({ module: "routine-worker" })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** How routine-tick-outcome.ts words a run whose own text says it is blocked. */
const REPORTED_BLOCKED = "The run reported itself blocked"
/** How routine-tick-outcome.ts words a run whose last turn stopped before its answer (`TURN_STOPPED_EARLY`). */
const TURN_STOPPED_EARLY = "The run's turn stopped before writing a final answer"

export const ROUTINE_LOCK_TTL_SECONDS = 10 * 60 // 10 min
export const ROUTINE_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000 // 5 min

export type RoutineRunStatus =
  // The run's turn parked a gated call: it resumes once the call is decided
  // (routine-run-resume.ts), and the row then takes its final status.
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "skipped_no_credits"
  | "skipped_overlap"
  | "skipped_scope_mismatch"
  | "output_thread_recreated"
  // The run was handed to a node job (P4, A50/F8); it settles when the job ends.
  | "dispatched"
  // The run needed its owner's private mailbox, which only the owner's unlocked
  // browser can read: it waits for the owner's Run now (routine-mailbox-wait.ts),
  // then takes its final status, or lapses after 24 hours.
  | "waiting_mailbox"
  | "mailbox_wait_expired"
  // The owner dismissed it from their approvals list instead of running it.
  | "mailbox_wait_dismissed"
  // A flow run (0303, flow-runner.ts): in progress, parked on a wait step, ended with an agent
  // step's required outcome missing, or ended because a wait's condition no longer held.
  | "running"
  | "waiting"
  | "flagged"
  | "skipped_condition"

/**
 * The triggering event for a kind:'event' tick — a compact projection of the `<app>:<entity>:<action>`
 * event the event-routine subscriber fired this tick for. Present ONLY on event-fired ticks (absent for
 * cron/scheduled/run-now). The worker prepends it to the routine prompt as DATA (prompt-injection-safe)
 * so the tick REACTS to the event that fired it (e.g. the `inventory:low` sku/available/threshold) rather
 * than blindly re-scanning live state. Reusable across every event routine (order:created, contact:create,
 * dealer PO, firmware release, …) — the data shape is whatever that event carries.
 */
export interface RoutineTriggerEvent {
  app: string
  entity: string
  action: string
  entityId: string | null
  data: unknown
  /** Whether the event carries text from outside the org (scopes/taint.ts). Absent = external. */
  origin?: import("~/modules/agent/scopes/taint").TriggerEventOrigin
  /**
   * The outbox id of the event (the id kernel.audit_log keeps as event_id). The run row records it,
   * which is how the reconciler (routine-event-reconciler.ts) tells a delivered event from a lost one.
   */
  eventId?: string | null
  /** Set by the reconciler: the nth time it fires the routine again for this event (1, 2, ...). */
  retryAttempt?: number
  /** How many routine runs led to the event (its `metadata.hop`; absent = 0). The run carries it on. */
  hop?: number
}

export interface RoutineTickOpts {
  orgId: string
  routineId: string
  scheduledAt: string // ISO
  requestUuid?: string // present for run-now invocations
  /**
   * The user who asked for this specific tick via `run_routine_now` (present ONLY on
   * manual run-now invocations; absent for cron/scheduled/event ticks). May differ
   * from `routine.ownerUserId` — e.g. a member run-nowing a shared routine owned by
   * an admin, or a run-now that went through the approval gate and executes under
   * `ctx.approverUserId` while the requester who originally asked was someone else.
   * Used ONLY to target the post-run "your routine ran" notification below; it does
   * not affect which identity the tick executes as (that stays `routine.ownerUserId`,
   * unchanged).
   */
  requestedByUserId?: string
  /** Present ONLY on an event-fired tick — the event the subscriber matched + fired for (see above). */
  triggerEvent?: RoutineTriggerEvent
  /**
   * When true and the per-routine lock is held by another tick, return
   * `{ status: "lock_busy" }` WITHOUT writing a run row, so the caller can
   * re-enqueue the tick later instead of dropping the event. Without this
   * (default), a held lock records `skipped_overlap` and the tick is lost —
   * fatal for event-fired ticks that carry a specific triggerEvent (e.g. a
   * new-ticket tick: the ticket would simply never be triaged).
   */
  deferOnOverlap?: boolean
  /**
   * Run now of a run waiting for its owner's private mailbox
   * (routine-mailbox-wait.ts): the nonce the owner's browser minted for this
   * run, so its reads go to that browser through the broker, and the waiting
   * run row this run settles. Set only by `runWaitingMailboxRun`.
   */
  mailboxTurnNonce?: string
  mailboxWaitRunId?: string
  /** The mail the owner's browser opened at Run now, for this run only (run-context.ts). */
  mailboxHandoff?: MailboxHandoff
  /** A flow routine's seams (flow-runner.ts): tests replace the tool call and the wait's job. */
  flowDeps?: import("~/modules/agent/routines/flow-runner").FlowDeps
  /**
   * Resolve effective scopes for the routine owner. Defaults to
   * `loadEffectivePermissions` against the kernel DB.
   */
  loadOwnerScopes?: (orgId: string, userId: string) => Promise<string[]>
  /**
   * Returns `null` when the user has credit, or why the tick cannot run: a
   * reason string (the org is out of credits: the routine pauses), or a
   * `RoutineCreditRefusal` that says whether the refusal pauses it.
   */
  checkCredits?: (orgId: string, userId: string) => Promise<string | RoutineCreditRefusal | null>
  /**
   * Invokes the agent for the routine prompt. Returns the number of
   * assistant turns appended to the output thread.
   *
   * The default implementation in kernel-jobs.ts wires this to
   * `sendMessage` + `invokeAgentForThread` under withRlsContext.
   */
  agentInvoker?: (input: {
    orgId: string
    ownerUserId: string
    threadId: string
    prompt: string
    scopes: string[]
    /** The triggering event for an event-fired tick (undefined for cron/scheduled/run-now). The
     *  invoker prepends a compact, prompt-injection-safe DATA block describing it to the prompt. */
    triggerEvent?: RoutineTriggerEvent
    /**
     * A flow's agent step with required outcomes (flow-runner.ts): asked after each turn, it
     * returns the steer naming what is still missing (the invoker re-prompts the tick with it,
     * the `repromptTickOnce` seam), or null when nothing is missing or the bumps are spent.
     * Absent on a legacy tick.
     */
    nextSteer?: () => Promise<string | null>
  }) => Promise<{
    turnsAdded: number
    /**
     * Why the tick could not do its job although no exception was thrown: a
     * tool it called was unavailable, or its output declares it blocked
     * (routine-tick-outcome.ts). The run is recorded as failed with this as
     * its error.
     */
    failure?: string | null
  }>
}

/**
 * A credit pre-check refusal. `pause` is true only when the org is out of
 * credits (or has no key to run on), a state that lasts until someone acts. A
 * refusal of the demo visitor gate ("confirm your email", the visitor's own
 * budget, the box's load) is about that one visitor's spend right now: the
 * tick is skipped and recorded, and the routine stays active.
 */
export interface RoutineCreditRefusal {
  reason: string
  pause: boolean
}

function creditRefusalOf(raw: string | RoutineCreditRefusal): RoutineCreditRefusal {
  return typeof raw === "string" ? { reason: raw, pause: true } : raw
}

export interface RoutineTickResult {
  status: RoutineRunStatus | "no_run" | "lock_busy"
  runId?: string
  durationMs?: number
}

/**
 * Default credit pre-check — kept light to avoid pulling the full credit
 * service into unit tests. The real `creditMeter.preCheck` lives in
 * `~/modules/agent/credits/credit-meter`; kernel-jobs.ts wires it in via
 * `defaultCheckCredits` in T5.3.
 */
async function defaultCheckCredits(_orgId: string, _userId: string): Promise<string | null> {
  return null
}

async function defaultAgentInvoker(_input: {
  orgId: string
  ownerUserId: string
  threadId: string
  prompt: string
  scopes: string[]
}): Promise<{ turnsAdded: number }> {
  // The Phase 5.3 wiring overrides this with the real agent invocation.
  log.warn(
    { routineId: _input.threadId },
    "Routine worker invoked with default no-op agentInvoker — Phase 5.3 wiring missing",
  )
  return { turnsAdded: 0 }
}

async function defaultLoadOwnerScopes(orgId: string, userId: string): Promise<string[]> {
  const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
  return withPrivilegedDb(orgId, "routine-perms", async (tx) => {
    const perms = await loadEffectivePermissions(tx, userId, orgId)
    return perms.scopes
  })
}

/**
 * Which of `routineScopes` are NOT covered by `ownerScopes`. Uses the canonical
 * `isScopeCovered` predicate so a `:*` glob grant (e.g. an MCP-backed routine
 * whose owner holds `mcp:jira:*`) covers `mcp:jira:read` — the same coverage
 * semantics the authoring path uses — rather than the old bare-prefix-only
 * helper that paused such routines as paused_scope_mismatch every tick.
 */
/**
 * D20: how a person fixes a scope pause, appended to the reason they read on the routine, its list
 * row and the run. Either the owner gets the scope back, or the routine stops needing it.
 */
const ROUTINE_SCOPE_FIX_HOW =
  "To fix it, give that scope back to the owner (the routine's next tick then runs again), or remove it from the routine (Edit > Scopes in the routine, or ask your agent to update the routine's scopes); saving the routine gives it another try."

function effectiveScopesMissing(routineScopes: string[], ownerScopes: string[]): string[] {
  return routineScopes.filter((req) => !isScopeCovered([req], ownerScopes))
}

/**
 * The scopes a routine's turn runs under: its granted scopes, plus the `:read` sibling of each
 * `:write` scope it was granted, when its owner holds that read.
 *
 * Rule 5 of scope-taint.ts classifies data a turn read under `X:write` as `X:read` (the one
 * sibling rule, `readerScopesOf`: whoever holds the write may read). A routine granted
 * `kernel:threads:write` alone read its own prompt (stamped with its scopes), so every row it
 * then caused, an approved call's result and the resume message quoting it among them, was
 * stamped `kernel:threads:read`, a scope the routine did not hold: the resumed turn could not
 * read its own task (2026-10-27). Holding the sibling read, the classification lands on a scope
 * the routine can read, and no stamp or gate changes.
 *
 * It widens nothing beyond that rule: only a `:write` scope's own `:read` sibling is added, and
 * only when the owner holds it, so the routine never reads what its owner cannot. The stored
 * `routine.scopes` is unchanged (no migration; the scope-gap checks still judge what was granted).
 */
export function routineRunScopes(routineScopes: string[], ownerScopes: string[]): string[] {
  const out = new Set(routineScopes)
  for (const scope of routineScopes) {
    if (!scope.endsWith(":write")) continue
    const read = `${scope.slice(0, -":write".length)}:read`
    if (!isScopeCovered([read], ownerScopes)) continue
    if (!isScopeCovered([read], [...out])) out.add(read)
  }
  return [...out]
}

export async function ensureOutputThread(
  orgId: string,
  routine: typeof routines.$inferSelect,
): Promise<{ threadId: string; recreated: boolean }> {
  // If we have a thread id, verify it still exists.
  if (routine.outputThreadId) {
    const exists = await withPrivilegedDb(orgId, "routine-thread-check", (tx) =>
      tx.select({ id: threads.id }).from(threads).where(eq(threads.id, routine.outputThreadId!)),
    )
    if (exists.length > 0) return { threadId: routine.outputThreadId, recreated: false }
  }
  // Create a new routine-output thread.
  //
  // SHARED visibility is LOAD-BEARING: thread visibility is purely participant-based (threads_select
  // RLS = the caller must be a thread_participant), so an output thread with ONLY the owner enrolled is
  // OWNER-PRIVATE — a `visibility:'shared'` routine (e.g. a team ops digest "so the team starts the week
  // aligned") would then post where the team can never see it. So when the routine is shared, enroll
  // EVERY active org member as a participant (+ user_thread_state so it surfaces in their thread list).
  // For a personal routine, only the owner is enrolled (the prior behavior). This makes the routine's
  // declared visibility the single source of truth for who sees its digest — the agent does not have to
  // pre-resolve/create+share a thread and pass its id; setting visibility:'shared' is sufficient.
  const isShared = routine.visibility === "shared"
  const newThreadId = await withPrivilegedDb(orgId, "routine-thread-create", async (tx) => {
    const handle = `routine-${routine.id.slice(0, 8)}-${Date.now()}`
    const [row] = await tx
      .insert(threads)
      .values({
        orgId,
        handle,
        title: routine.name,
        type: "routine",
        createdBy: routine.ownerUserId,
      })
      .returning({ id: threads.id })

    // Determine the participant set. Owner is always an admin participant; a shared routine ALSO enrolls
    // every other active org member as a participant so the team can see the digest. De-dup the owner.
    const memberIds = new Set<string>([routine.ownerUserId])
    if (isShared) {
      const orgUsers = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.orgId, orgId), eq(users.status, "active")))
      for (const u of orgUsers) memberIds.add(u.id)
    }

    await tx.insert(threadParticipants).values(
      [...memberIds].map((userId) => ({
        threadId: row.id,
        userId,
        orgId,
        // The owner administers the routine thread; other shared members are plain participants.
        role: userId === routine.ownerUserId ? ("admin" as const) : ("member" as const),
      })),
    )
    await tx.insert(userThreadState).values(
      [...memberIds].map((userId) => ({
        userId,
        threadId: row.id,
        orgId,
      })),
    )
    return row.id
  })
  await withPrivilegedDb(orgId, "routine-thread-link", (tx) =>
    tx
      .update(routines)
      .set({ outputThreadId: newThreadId, updatedAt: new Date() })
      .where(eq(routines.id, routine.id)),
  )
  return { threadId: newThreadId, recreated: !!routine.outputThreadId }
}

/** What started a tick, as the run history names it. */
export type RoutineRunTrigger = "schedule" | "event" | "manual" | "retry"

/** The trigger of a tick, read off its options: an event tick carries the
 *  event, a run-now carries its request id, anything else is the schedule. */
export function routineRunTrigger(opts: Pick<RoutineTickOpts, "triggerEvent" | "requestUuid">): {
  trigger: RoutineRunTrigger
  triggerLabel: string | null
} {
  const ev = opts.triggerEvent
  if (ev) {
    const triggerLabel = `${ev.app}.${ev.entity}.${ev.action}`
    return { trigger: (ev.retryAttempt ?? 0) > 0 ? "retry" : "event", triggerLabel }
  }
  if (opts.requestUuid) return { trigger: "manual", triggerLabel: null }
  return { trigger: "schedule", triggerLabel: null }
}

export async function writeRunRow(
  orgId: string,
  routineId: string,
  status: RoutineRunStatus,
  fields: {
    /** A flow run's step states (flow-runner.ts). */
    steps?: RoutineRunStepState[]
    /** What a flow run's resume needs (flow-runner.ts). */
    flowContext?: RoutineRunFlowContext
    durationMs?: number
    error?: string
    turnsAdded?: number
    /** The tick's options, for the trigger the run history shows. */
    tick?: Pick<RoutineTickOpts, "triggerEvent" | "requestUuid">
    startedAt?: Date
    /** A run that waits for an approval (routine-run-resume.ts). */
    pauseState?: RoutineRunPauseState
  } = {},
): Promise<string> {
  const trigger = fields.tick ? routineRunTrigger(fields.tick) : null
  const ev = fields.tick?.triggerEvent
  const eventId = ev?.eventId && UUID_RE.test(ev.eventId) ? ev.eventId : null
  return withPrivilegedDb(orgId, `routine-run-write:${status}`, async (tx) => {
    const [row] = await tx
      .insert(routineRuns)
      .values({
        orgId,
        routineId,
        status,
        ranAt: new Date(),
        durationMs: fields.durationMs ?? null,
        error: fields.error ?? null,
        turnsAdded: fields.turnsAdded ?? null,
        trigger: trigger?.trigger ?? null,
        triggerLabel: trigger?.triggerLabel ?? null,
        startedAt: fields.startedAt ?? null,
        eventId,
        eventEntityId: ev?.entityId ?? null,
        attempt: ev?.retryAttempt ?? 0,
        pauseState: fields.pauseState ?? null,
        ...(fields.steps ? { steps: fields.steps } : {}),
        ...(fields.flowContext ? { flowContext: fields.flowContext } : {}),
      })
      .returning({ id: routineRuns.id })
    return row.id
  })
}

/** Settle a run row a paused run already has: its final status, once it ends. */
async function settleRunRow(
  orgId: string,
  runId: string,
  status: RoutineRunStatus,
  fields: { durationMs: number; error: string | null; turnsAdded: number },
): Promise<boolean> {
  // Only a run still waiting: one a resume or the sweep already ended stays as it ended.
  const rows = await withPrivilegedDb(orgId, `routine-run-settle:${status}`, (tx) =>
    tx
      .update(routineRuns)
      .set({
        status,
        ranAt: new Date(),
        durationMs: fields.durationMs,
        error: fields.error,
        turnsAdded: fields.turnsAdded,
      })
      .where(
        and(
          eq(routineRuns.id, runId),
          eq(routineRuns.orgId, orgId),
          inArray(routineRuns.status, ["waiting_approval", "waiting_mailbox"]),
        ),
      )
      .returning({ id: routineRuns.id }),
  )
  return rows.length > 0
}

/**
 * The event's tick (its first one or a reconciler retry) has landed its run
 * row: the next pass judges it from that row, so the event's in-flight marker
 * goes (routine-event-reconciler.ts).
 */
async function clearEventInFlight(routineId: string, eventId: string | null | undefined) {
  if (!eventId) return
  const { inFlightKey } = await import("~/modules/agent/routines/routine-event-reconciler")
  await redis
    .del(inFlightKey(routineId, eventId))
    .catch((err) => log.warn({ err, routineId }, "Retry marker not cleared"))
}

/** Take the routine's run lock: the token when taken, null when another run holds it. */
export async function acquireRoutineLock(routineId: string): Promise<string | null> {
  const token = crypto.randomUUID()
  const got = await redis.set(
    `routine-lock:${routineId}`,
    token,
    "EX",
    ROUTINE_LOCK_TTL_SECONDS,
    "NX",
  )
  return got === "OK" ? token : null
}

/** Tests shorten the heartbeat to watch it renew the lock. */
export const RoutineLockTestAccess = { heartbeatMs: ROUTINE_HEARTBEAT_INTERVAL_MS }

/**
 * Keep the routine lock alive while a long run holds it (a tick, a paused
 * run's resume): its TTL is refreshed every few minutes. Returns the stop.
 */
export function startRoutineLockHeartbeat(
  routineId: string,
  lockKey = `routine-lock:${routineId}`,
): () => void {
  const heartbeat = setInterval(() => {
    redis.expire(lockKey, ROUTINE_LOCK_TTL_SECONDS).catch((err) => {
      log.warn({ err, routineId }, "Failed to refresh routine lock TTL")
    })
  }, RoutineLockTestAccess.heartbeatMs)
  // Unref the timer so it doesn't keep the process alive (Bun/Node compat).
  // setInterval returns Timer in Bun; Timer.unref exists in Node too.
  if (typeof (heartbeat as { unref?: () => unknown }).unref === "function") {
    ;(heartbeat as { unref: () => unknown }).unref()
  }
  return () => clearInterval(heartbeat)
}

/** Give the lock back, only while this token still holds it. */
export async function releaseRoutineLock(routineId: string, token: string): Promise<void> {
  const releaseLua = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `
  try {
    await redis.eval(releaseLua, 1, `routine-lock:${routineId}`, token)
  } catch (err) {
    log.warn({ err, routineId }, "Failed to release routine lock")
  }
}

/**
 * Emit a routine WebSocket event so the UI's routines store can update without
 * a manual reload. Fans out on channels `kernel.routine.run_completed` /
 * `kernel.routine.status`; owner-targeted delivery is enforced by the WS layer's
 * user-scoped routing.
 *
 * Delivery guarantee is split by action (F2):
 *   - `run_completed` is DURABLE — the run finished and its result must survive a
 *     crash and replay on reconnect, so it rides the transactional outbox
 *     (tx.queueEvent). See the note below on why it is a SEPARATE tx from the run
 *     row write, and hence best-effort.
 *   - `status` is EPHEMERAL (no outbox write) — a transient badge nudge with no
 *     lasting state to reconcile, so it goes out via broadcastEphemeral.
 * Frame shape is identical on both paths, so the frontend routine handler applies
 * either verbatim.
 *
 * A11 — a tick IS an agent turn, so the routine's OWNER AGENT rides the event and
 * lands in `audit_log.agent_id`; without it "what did this agent do" misses every
 * scheduled action the agent ever took. `ownerAgentId` comes from the routine row
 * the caller already loaded, and is passed EXPLICITLY (null included) so it beats
 * any frame that happens to be live around the tick: the identity recorded is the
 * routine's own, never whichever turn asked for the run. A routine with no owner
 * agent records null, never a guess and never the owning human, who stays in
 * `actorId` where they belong.
 */
export async function emitRoutineEvent(
  orgId: string,
  ownerUserId: string,
  ownerAgentId: string | null,
  routineId: string,
  action: "status" | "run_completed" | "run_started",
  data: Record<string, unknown>,
): Promise<void> {
  const payload = {
    app: "kernel" as const,
    entity: "routine" as const,
    action,
    entityId: routineId,
    data: { routineId, ...data },
    actorId: ownerUserId,
    actorType: "system" as const,
    agentId: ownerAgentId,
    orgId,
  }

  // F2 — `run_completed` is a DURABLE transition: the run finished and its result
  // must survive a crash and replay on reconnect (a client offline when the run
  // completed would otherwise never see the "Done" flip / run-history entry).
  // Route it through the transactional outbox.
  //
  // BEST-EFFORT: this helper is invoked by the worker AFTER `writeRoutineRun` has
  // already committed the durable `routine_runs` row in its own tx (it returns the
  // runId this frame carries), so the queueEvent here rides a SEPARATE privileged
  // tx and is not atomic with that run-row write. Ideally it would ride the same
  // tx that inserts the run row (see auto-title.ts, which does UPDATE +
  // tx.queueEvent atomically) — but that write is not in scope of this shared
  // emit helper. A durable-emit failure is therefore best-effort: the run row is
  // already persisted, so a reconnecting client re-reads the completed run via the
  // normal hydration path even if this WS frame is lost. Log at ERROR (not WARN)
  // so a silently-dropped run-completed frame is visible as a field-reportable issue.
  if (action === "run_completed") {
    try {
      await withPrivilegedDb(orgId, "routine-emit-run-completed", async (tx) => {
        await tx.queueEvent(payload)
      })
    } catch (err) {
      log.error(
        { err, routineId, action },
        "Failed to queue durable routine run_completed event (best-effort — run row already committed)",
      )
    }
    return
  }

  try {
    await broadcastEphemeral(payload)
  } catch (err) {
    log.warn({ err, routineId, action }, "Failed to broadcast routine WS event")
  }
}

/**
 * A run is under way (a cloud turn about to start, or a node job dispatched):
 * said live, so a screen waiting on the routine (a guided tour's step) can say
 * that it works, and on what (`eventEntityId`: the event's entity, the ticket a
 * new-ticket routine reads). Ephemeral: the run row and its `run_completed`
 * are the lasting record.
 */
async function emitRunStarted(
  opts: RoutineTickOpts,
  routine: typeof routines.$inferSelect,
  startedAt: number,
): Promise<void> {
  const { trigger, triggerLabel } = routineRunTrigger(opts)
  await emitRoutineEvent(
    opts.orgId,
    routine.ownerUserId,
    routine.ownerAgentId,
    routine.id,
    "run_started",
    {
      routineName: routine.name,
      startedAt: new Date(startedAt).toISOString(),
      trigger,
      triggerLabel,
      eventEntityId: opts.triggerEvent?.entityId ?? null,
    },
  )
  // A tour step waiting on this routine reads that it runs from the server,
  // whatever frames its tab heard (modules/tours/beat-status.ts).
  const { noteRoutineRunStarted } = await import("~/modules/tours/beat-status")
  await noteRoutineRunStarted({
    orgId: opts.orgId,
    routineId: routine.id,
    routineName: routine.name,
    eventEntityId: opts.triggerEvent?.entityId ?? null,
    startedAt: new Date(startedAt).toISOString(),
  })
}

/**
 * A tick that recorded a run row without running (skipped for credits or
 * scope) says its outcome as a finished run does, with why: whoever waits on
 * the routine learns it will not come, instead of waiting in silence.
 */
export async function emitRunSkipped(
  opts: RoutineTickOpts,
  routine: typeof routines.$inferSelect,
  runId: string,
  status: RoutineRunStatus,
  error: string,
): Promise<void> {
  const ranAt = new Date().toISOString()
  const eventEntityId = opts.triggerEvent?.entityId ?? null
  await emitRoutineEvent(
    opts.orgId,
    routine.ownerUserId,
    routine.ownerAgentId,
    routine.id,
    "run_completed",
    {
      run: {
        id: runId,
        routineId: routine.id,
        ranAt,
        status,
        durationMs: null,
        errorMessage: error,
        eventEntityId,
      },
      runId,
      status,
      routineName: routine.name,
      eventEntityId,
      ranAt,
      error,
    },
  )
}

/**
 * Why a routine cannot run as it stands, or null: its owner no longer holds a
 * scope it needs (scope drift), or its owner agent's ceiling does not cover
 * them. Asked by every tick, and by a paused run before it resumes
 * (routine-run-resume.ts): a run that waited for an approval must not carry on
 * with access its owner lost meanwhile.
 *
 * A SENTENCE, because this string is what the person reading the routine
 * sees (RoutinesList, RoutineDetail and the run row all render it). A status
 * enum says THAT it stopped; only this says why, and which scope.
 */
export async function routineScopeGap(
  orgId: string,
  routine: typeof routines.$inferSelect,
  ownerScopes: string[],
): Promise<string | null> {
  // AN OWNER WHO LEFT. A routine acts for its owner; once that person's account is deactivated
  // (or suspended) it acts for nobody, whatever scopes their roles still list. It pauses like a
  // scope pause, so it reads paused with the reason, and its first tick after the owner is
  // reactivated runs it again (the way back is the owner's account, as with a scope given back).
  const ownerStatus = await routineOwnerStatus(orgId, routine.ownerUserId)
  if (ownerStatus !== null && ownerStatus !== "active") {
    return routineOwnerInactiveReason(ownerStatus)
  }
  const missing = effectiveScopesMissing(routine.scopes ?? [], ownerScopes)
  if (missing.length > 0) {
    return (
      `Paused: the owner no longer holds ${missing.join(", ")}, which this routine needs, so its tool calls would be refused. ` +
      `${ROUTINE_SCOPE_FIX_HOW}`
    )
  }
  // AN OWNER THAT CAN CALL NOTHING (T26 F8).
  //
  // A routine tick runs at its owner agent's ceiling, unfloored
  // (`effectiveScopeRoutineTick`), and a tool the actor holds no scope for is
  // not in the catalog at all: an empty ceiling is an empty tool set, so
  // every call the prompt makes is refused and the tick "succeeds" having
  // done nothing. `@base` carries exactly that ceiling, and the roster
  // migration re-owns an offboarded user's orphaned routines to it, so this
  // is the shape those routines take. Skipping loudly, with a run row and a
  // pause, is the difference between a visible blocker and a routine that
  // quietly stopped working.
  //
  // AN EMPTY CEILING IS THE EXTREME CASE, NOT THE ONLY ONE (P8-FX2, SK-2). A
  // ceiling of `["kernel:threads:read"]` under a routine needing
  // `invoicing:documents:write` is non-empty and covers nothing the routine
  // asks for: the tick passes, the catalog holds none of its tools, and it
  // reports success having done nothing, which is the same silence. The
  // comparison the owner drift check three blocks above already makes
  // against the owner's grants is the comparison to make here against the
  // ceiling, and the migration's own `routineCeilingMismatches` makes it too.
  const ownerCeiling = await ownerAgentCeiling(orgId, routine.ownerAgentId)
  const ceilingMissing =
    ownerCeiling === null ? [] : effectiveScopesMissing(routine.scopes ?? [], ownerCeiling)
  if (ownerCeiling !== null && (ownerCeiling.length === 0 || ceilingMissing.length > 0)) {
    return ceilingMissing.length > 0
      ? `Paused: the owner agent's scope ceiling does not cover ${ceilingMissing.join(", ")}, so the tools this routine needs are not in its catalog. ${ROUTINE_SCOPE_FIX_HOW}`
      : "Paused: the owner agent holds no scopes, so every tool call this routine makes would be refused."
  }
  return null
}

/** Pause a routine whose scopes no longer hold (`routineScopeGap`); its owner is told. */
export async function pauseRoutineForScopeGap(
  orgId: string,
  routine: typeof routines.$inferSelect,
  error: string,
): Promise<void> {
  await markPaused(
    orgId,
    routine.ownerUserId,
    routine.ownerAgentId,
    routine.id,
    "paused_scope_mismatch",
    error,
    routine,
  )
}

/** The routine owner's account status, or null when the owner row is gone (nothing to judge). */
async function routineOwnerStatus(orgId: string, ownerUserId: string): Promise<string | null> {
  const [owner] = await withPrivilegedDb(orgId, "routine-owner-status", (tx) =>
    tx
      .select({ status: users.status })
      .from(users)
      .where(and(eq(users.id, ownerUserId), eq(users.orgId, orgId)))
      .limit(1),
  )
  return owner?.status ?? null
}

/**
 * The scope ceiling of the agent a routine is owned by, or null when the
 * routine has no owner agent or its owner row is gone (nothing to judge).
 */
async function ownerAgentCeiling(
  orgId: string,
  ownerAgentId: string | null,
): Promise<string[] | null> {
  if (!ownerAgentId) return null
  const [owner] = await withPrivilegedDb(orgId, "routine-owner-ceiling", (tx) =>
    tx
      .select({ scopeCeiling: agentsTbl.scopeCeiling })
      .from(agentsTbl)
      .where(and(eq(agentsTbl.id, ownerAgentId), eq(agentsTbl.orgId, orgId)))
      .limit(1),
  )
  return owner ? (owner.scopeCeiling ?? []) : null
}

async function markPaused(
  orgId: string,
  ownerUserId: string,
  ownerAgentId: string | null,
  routineId: string,
  status: "paused_scope_mismatch" | "paused_no_credits" | "paused_user",
  lastRunError: string | null,
  /** The routine, when the pause is automatic: its owner is told on Home (D21). */
  alertFor?: RoutineAlertRoutine,
): Promise<void> {
  await withPrivilegedDb(orgId, `routine-mark-paused:${status}`, async (tx) => {
    await tx
      .update(routines)
      .set({
        status,
        lastRunAt: new Date(),
        lastRunStatus: status,
        lastRunError,
        updatedAt: new Date(),
      })
      .where(eq(routines.id, routineId))
    if (alertFor && status !== "paused_user") {
      await queueRoutineAlert(tx, { orgId, routine: alertFor, status, error: lastRunError })
    }
  })
  // Notify the UI so the routine row's status badge flips immediately.
  await emitRoutineEvent(orgId, ownerUserId, ownerAgentId, routineId, "status", {
    status,
    lastRunError,
    ranAt: new Date().toISOString(),
  })
}

/**
 * The last-run fields of a tick skipped at the credit check without a new
 * pause; `status` set means the routine's status changes to it.
 */
async function recordSkippedLastRun(
  opts: Pick<RoutineTickOpts, "orgId">,
  routine: typeof routines.$inferSelect,
  status: "active" | null,
  error: string,
): Promise<void> {
  await withPrivilegedDb(opts.orgId, "routine-credit-skip-last-run", (tx) =>
    tx
      .update(routines)
      .set({
        ...(status ? { status } : {}),
        lastRunAt: new Date(),
        lastRunStatus: "skipped_no_credits",
        lastRunError: error,
        updatedAt: new Date(),
      })
      .where(eq(routines.id, routine.id)),
  )
  if (status && status !== routine.status) {
    log.info(
      { routineId: routine.id, orgId: opts.orgId, from: routine.status },
      "routine resumed: its pause was not the org running out of credits",
    )
    await emitRoutineEvent(
      opts.orgId,
      routine.ownerUserId,
      routine.ownerAgentId,
      routine.id,
      "status",
      {
        status,
        lastRunError: error,
        ranAt: new Date().toISOString(),
      },
    )
  }
}

/**
 * A routine the system paused (for credits, or for its owner's scopes or account) whose check now
 * passes goes back to active.
 */
async function resumeSystemPausedRoutine(
  opts: Pick<RoutineTickOpts, "orgId">,
  routine: typeof routines.$inferSelect,
  from: "paused_no_credits" | "paused_scope_mismatch",
): Promise<void> {
  await withPrivilegedDb(opts.orgId, `routine-resume:${from}`, (tx) =>
    tx
      .update(routines)
      .set({ status: "active", lastRunError: null, updatedAt: new Date() })
      .where(and(eq(routines.id, routine.id), eq(routines.status, from))),
  )
  log.info(
    { routineId: routine.id, orgId: opts.orgId, from },
    "routine resumed: its pause no longer holds",
  )
  await emitRoutineEvent(
    opts.orgId,
    routine.ownerUserId,
    routine.ownerAgentId,
    routine.id,
    "status",
    {
      status: "active",
      lastRunError: null,
      ranAt: new Date().toISOString(),
    },
  )
}

// ── Pre-run checks, shared by a tick and a flow run's resume ────────────────

/**
 * The state that keeps a routine from running (switched off, paused by its owner or its app, a
 * one-shot done, an app-run routine), or null when it may run. A routine the system paused for
 * credits or for its owner's scopes (or account) is not inactive here: its run re-checks the cause
 * (`applyRoutineCreditCheck`, `applyRoutineScopeCheck`), and a check that passes sets it back to
 * active, as nothing else would.
 */
export function routineInactiveState(routine: typeof routines.$inferSelect): string | null {
  if (!routine.enabled) return "disabled"
  // An app-run routine has no tick of its own (kernel-routine-templates.ts).
  if (isAppRunRoutine(routine.templateKey)) return "app_run"
  if (
    routine.status === "active" ||
    routine.status === "paused_no_credits" ||
    routine.status === "paused_scope_mismatch"
  ) {
    return null
  }
  return routine.status
}

/**
 * The scope check (`routineScopeGap`: an owner who left, scope drift, an owner agent's ceiling
 * that covers nothing it needs) with its effect on the routine: a gap pauses it (its owner is
 * told once; a changed reason is written without a second alert), a cleared scope pause sets it
 * back to active. Returns the gap, or null.
 */
export async function applyRoutineScopeCheck(
  orgId: string,
  routine: typeof routines.$inferSelect,
  ownerScopes: string[],
): Promise<string | null> {
  const scopePaused = routine.enabled && routine.status === "paused_scope_mismatch"
  const scopeGap = await routineScopeGap(orgId, routine, ownerScopes)
  if (scopeGap) {
    if (!scopePaused) {
      await pauseRoutineForScopeGap(orgId, routine, scopeGap)
    } else if (routine.lastRunError !== scopeGap) {
      await markPaused(
        orgId,
        routine.ownerUserId,
        routine.ownerAgentId,
        routine.id,
        "paused_scope_mismatch",
        scopeGap,
      )
    }
    return scopeGap
  }
  if (scopePaused) await resumeSystemPausedRoutine({ orgId }, routine, "paused_scope_mismatch")
  return null
}

/**
 * The credit pre-check with its effect on the routine: an org out of credits pauses it (its
 * owner is told once), a refusal that never pauses (a demo visitor's gate) is recorded on it, and
 * a cleared credit pause sets it back to active. Returns the refusal's reason, or null.
 */
export async function applyRoutineCreditCheck(
  orgId: string,
  routine: typeof routines.$inferSelect,
  checkCredits: RoutineTickOpts["checkCredits"],
): Promise<string | null> {
  const creditPaused = routine.enabled && routine.status === "paused_no_credits"
  const credit = checkCredits ?? defaultCheckCredits
  const rawRefusal = await credit(orgId, routine.ownerUserId)
  if (rawRefusal !== null) {
    const refusal = creditRefusalOf(rawRefusal)
    if (refusal.pause && !creditPaused) {
      await markPaused(
        orgId,
        routine.ownerUserId,
        routine.ownerAgentId,
        routine.id,
        "paused_no_credits",
        refusal.reason,
        routine,
      )
    } else {
      // Still out of credits (already paused: its owner was told once), or a refusal that never
      // pauses: the run says why, and a routine a demo refusal once paused goes back to active.
      await recordSkippedLastRun(
        { orgId },
        routine,
        refusal.pause ? null : "active",
        refusal.reason,
      )
    }
    return refusal.reason
  }
  if (creditPaused) await resumeSystemPausedRoutine({ orgId }, routine, "paused_no_credits")
  return null
}

/**
 * Whether the leg of a flow that starts at `fromIndex` spends model tokens: an agent step comes
 * before the next wait (a wait ends the leg; its resume checks again). Action, notify and message
 * steps run without a model, so a leg of them needs no credits and no model key.
 */
export function flowLegNeedsCredits(
  steps: ReadonlyArray<{ type: string }>,
  fromIndex: number,
): boolean {
  for (const step of steps.slice(fromIndex)) {
    if (step.type === "agent") return true
    if (step.type === "wait") return false
  }
  return false
}

/** Why a run that resumes (a flow's wait came due, its approval was decided) may not go on. */
export type RoutineResumeRefusal = {
  status: "skipped_condition" | "skipped_scope_mismatch" | "skipped_no_credits"
  reason: string
}

/**
 * The checks a tick makes before it runs, made again by a run that resumes (flow-runner.ts):
 * the routine still switched on and active, its owner still active and holding its scopes, its
 * owner agent's ceiling still covering them, and, when the rest of the run spends model tokens
 * (`needsCredits`), the credit gate. Their effects on the routine are a tick's (a pause, a resume).
 */
export async function routineResumeGate(
  orgId: string,
  routine: typeof routines.$inferSelect,
  deps: Pick<RoutineTickOpts, "loadOwnerScopes" | "checkCredits">,
  needsCredits: boolean,
): Promise<{ ok: true; ownerScopes: string[] } | ({ ok: false } & RoutineResumeRefusal)> {
  const inactive = routineInactiveState(routine)
  if (inactive) {
    return {
      ok: false,
      status: "skipped_condition",
      reason: `The run did not go on: the routine is ${inactive === "disabled" ? "switched off" : inactive.replace(/_/g, " ")}.`,
    }
  }
  const ownerScopes = await (deps.loadOwnerScopes ?? defaultLoadOwnerScopes)(
    orgId,
    routine.ownerUserId,
  )
  const scopeGap = await applyRoutineScopeCheck(orgId, routine, ownerScopes)
  if (scopeGap) return { ok: false, status: "skipped_scope_mismatch", reason: scopeGap }
  if (needsCredits) {
    const refusal = await applyRoutineCreditCheck(orgId, routine, deps.checkCredits)
    if (refusal) return { ok: false, status: "skipped_no_credits", reason: refusal }
  }
  return { ok: true, ownerScopes }
}

/**
 * A tick of a routine that is switched off or paused: never a silent skip. An
 * automatic scope pause records a `skipped_scope_mismatch` run with the reason
 * the pause gave, so the run history and whoever waits on the routine (a tour
 * step) learn the tick will not come. A state its owner chose (switched off,
 * paused, its app off, a one-shot done) is said on the routine itself; the tick
 * says it in the log.
 */
async function recordInactiveSkip(
  opts: RoutineTickOpts,
  routine: typeof routines.$inferSelect,
): Promise<RoutineTickResult> {
  const state = routine.enabled ? routine.status : "disabled"
  const { trigger, triggerLabel } = routineRunTrigger(opts)
  log.info(
    {
      routineId: routine.id,
      orgId: opts.orgId,
      state,
      trigger,
      triggerLabel,
      eventEntityId: opts.triggerEvent?.entityId ?? null,
    },
    `routine tick skipped: the routine is ${state}`,
  )
  if (routine.enabled && routine.status === "paused_scope_mismatch") {
    const error =
      routine.lastRunError ??
      "Skipped: the routine is paused because its owner no longer holds the scopes it needs."
    const runId = await writeRunRow(opts.orgId, routine.id, "skipped_scope_mismatch", {
      error,
      tick: opts,
    })
    await emitRunSkipped(opts, routine, runId, "skipped_scope_mismatch", error)
    return { status: "skipped_scope_mismatch", runId }
  }
  return { status: "no_run" }
}

/** A node dispatch that failed: its run row says `failed`, and so does the routine. */
async function failNodeDispatch(
  opts: RoutineTickOpts,
  routine: typeof routines.$inferSelect,
  dispatchedRunId: string | null,
  err: unknown,
  startedAt: number,
): Promise<RoutineTickResult> {
  const error = err instanceof Error ? err.message : String(err)
  const durationMs = Date.now() - startedAt
  let runId = dispatchedRunId
  if (runId) {
    const failed = runId
    await withPrivilegedDb(opts.orgId, "routine-node-dispatch-failed", (tx) =>
      tx
        .update(routineRuns)
        .set({ status: "failed", error, durationMs })
        .where(eq(routineRuns.id, failed)),
    )
  } else {
    runId = await writeRunRow(opts.orgId, routine.id, "failed", { error, durationMs, tick: opts })
  }
  await withPrivilegedDb(opts.orgId, "routine-node-dispatch-last-run", async (tx) => {
    await tx
      .update(routines)
      .set({
        lastRunAt: new Date(),
        lastRunStatus: "failed",
        lastRunError: error,
        updatedAt: new Date(),
      })
      .where(eq(routines.id, routine.id))
    await queueRoutineAlert(tx, { orgId: opts.orgId, routine, status: "failed", error })
  })
  return { status: "failed", runId, durationMs }
}

/**
 * Where this tick runs (S21, D9, A57), decided after the scope pre-checks and
 * before the credit one: `node` (a node job), or `cloud`, with `fellBack` when
 * `node_else_cloud` found no live node. A routine that cannot run where it is
 * set to run (`node` without an owner agent) fails the tick here.
 */
async function planTickLocation(
  opts: RoutineTickOpts,
  routine: typeof routines.$inferSelect,
): Promise<{ plan: RoutineRunPlan } | { result: RoutineTickResult }> {
  if ((routine.runsOn ?? "cloud") === "cloud") return { plan: { where: "cloud", fellBack: false } }
  const startedAt = Date.now()
  const { planRoutineRun } = await import("~/modules/nodes/routine-dispatch")
  try {
    return { plan: await planRoutineRun({ routine }) }
  } catch (err) {
    return { result: await failNodeDispatch(opts, routine, null, err, startedAt) }
  }
}

function nodeRunInput(
  opts: RoutineTickOpts,
  routine: typeof routines.$inferSelect,
  outputThreadId: string,
) {
  return {
    routine,
    threadId: outputThreadId,
    prompt: withReportSentence(withTokenBudgetSentence(routine.prompt, routine), routine),
    triggerEvent: opts.triggerEvent,
    tokenAccount: createRunTokenAccount(routine),
  }
}

/**
 * The node branch of a tick (P4 T3): the run row says `dispatched` and the
 * run becomes a node job; `failed` when the job could not be created.
 */
async function dispatchToNode(
  opts: RoutineTickOpts,
  routine: typeof routines.$inferSelect,
  outputThreadId: string,
): Promise<RoutineTickResult> {
  const startedAt = Date.now()
  const { dispatchRoutineToNode } = await import("~/modules/nodes/routine-dispatch")
  let runId: string | null = null
  try {
    runId = await writeRunRow(opts.orgId, routine.id, "dispatched", {
      tick: opts,
      startedAt: new Date(startedAt),
    })
    await dispatchRoutineToNode({ ...nodeRunInput(opts, routine, outputThreadId), runId })
  } catch (err) {
    return failNodeDispatch(opts, routine, runId, err, startedAt)
  }
  await emitRunStarted(opts, routine, startedAt)
  // The conversation the routine posts to says that it runs, as a cloud tick
  // does; keyed on the run row, which the node job settles (nodes/jobs.ts).
  if (routine.reportThreadId) {
    const loadScopes = opts.loadOwnerScopes ?? defaultLoadOwnerScopes
    await postRunStarted({
      orgId: opts.orgId,
      routine,
      outputThreadId,
      runKey: runId,
      ownerScopes: await loadScopes(opts.orgId, routine.ownerUserId),
    })
  }
  const durationMs = Date.now() - startedAt
  await withPrivilegedDb(opts.orgId, "routine-node-dispatched", (tx) =>
    tx
      .update(routines)
      .set({
        lastRunAt: new Date(),
        lastRunStatus: "dispatched",
        lastRunError: null,
        updatedAt: new Date(),
      })
      .where(eq(routines.id, routine.id)),
  )
  await emitRoutineEvent(
    opts.orgId,
    routine.ownerUserId,
    routine.ownerAgentId,
    routine.id,
    "status",
    {
      status: routine.status,
      lastRunStatus: "dispatched",
      runId,
      ranAt: new Date().toISOString(),
    },
  )
  return { status: "dispatched", runId, durationMs }
}

/**
 * Per-tick state machine. Returns a `RoutineTickResult` so callers can
 * observe what happened (used by tests + kernel-jobs metrics).
 */
/**
 * The lock a tick takes: the routine's, or for an event tick of a FLOW routine the routine's and
 * the record's (0303), so a flow runs for two tasks at once while one task's runs stay in order.
 */
async function tickLockKey(opts: RoutineTickOpts): Promise<string> {
  const entityId = opts.triggerEvent?.entityId
  if (!entityId) return `routine-lock:${opts.routineId}`
  const [row] = await withPrivilegedDb(opts.orgId, "routine-lock-kind", (tx) =>
    tx
      .select({ id: routines.id })
      .from(routines)
      .where(
        and(
          eq(routines.id, opts.routineId),
          eq(routines.orgId, opts.orgId),
          isNotNull(routines.flow),
        ),
      )
      .limit(1),
  )
  return row ? `routine-lock:${opts.routineId}:${entityId}` : `routine-lock:${opts.routineId}`
}

export async function runRoutineTick(opts: RoutineTickOpts): Promise<RoutineTickResult> {
  const lockKey = await tickLockKey(opts)
  const lockToken = crypto.randomUUID()

  const got = await redis.set(lockKey, lockToken, "EX", ROUTINE_LOCK_TTL_SECONDS, "NX")
  if (got !== "OK") {
    if (opts.deferOnOverlap) {
      // No run row: the caller re-enqueues this tick, so nothing was skipped yet.
      return { status: "lock_busy" }
    }
    const runId = await writeRunRow(opts.orgId, opts.routineId, "skipped_overlap", { tick: opts })
    return { status: "skipped_overlap", runId }
  }

  // Heartbeat the lock so a long agent run doesn't release it early.
  const stopHeartbeat = startRoutineLockHeartbeat(opts.routineId, lockKey)

  try {
    const routine = await withPrivilegedDb(opts.orgId, "routine-load", async (tx) => {
      const rows = await tx
        .select()
        .from(routines)
        .where(and(eq(routines.id, opts.routineId), eq(routines.orgId, opts.orgId)))
      return rows[0]
    })

    if (!routine) {
      // Orphan: scheduler still firing but row gone. Remove the scheduler.
      try {
        await removeScheduledJob("kernel", "routine-tick", `routine:${opts.routineId}`)
      } catch (err) {
        log.warn({ err, routineId: opts.routineId }, "Orphan routine: failed to remove scheduler")
      }
      return { status: "no_run" }
    }

    const creditPaused = routine.enabled && routine.status === "paused_no_credits"
    if (routineInactiveState(routine)) return recordInactiveSkip(opts, routine)

    // A scheduled tick while an earlier run of this routine waits for an
    // approval (routine-run-resume.ts) is skipped: that run carries on once the
    // decision comes, and a second one would pile up behind the same approval.
    // Event ticks run (each is for its own event), and so does a run-now.
    // A follow-up routine never waits, so a row left from before it was one
    // cannot hold its ticks back: that run finishes on its own decisions.
    if (!opts.triggerEvent && !opts.requestUuid && !routine.followUp) {
      const [waiting] = await withPrivilegedDb(opts.orgId, "routine-waiting-run-check", (tx) =>
        tx
          .select({ id: routineRuns.id })
          .from(routineRuns)
          .where(
            and(
              eq(routineRuns.routineId, routine.id),
              eq(routineRuns.orgId, opts.orgId),
              eq(routineRuns.status, "waiting_approval"),
            ),
          )
          .limit(1),
      )
      if (waiting) {
        const runId = await writeRunRow(opts.orgId, routine.id, "skipped_overlap", {
          error: "Skipped: an earlier run of this routine is waiting for an approval.",
          tick: opts,
        })
        return { status: "skipped_overlap", runId }
      }
    }

    // A run of this routine waits for its owner's private mailbox
    // (routine-mailbox-wait.ts): every other SCHEDULED tick is skipped until
    // the owner runs it or it lapses (24 h), so an hourly routine makes one
    // wait, not a pile. An event tick is not: a parked run is not in flight
    // (it holds no lock), and each event is its own work, so the event runs
    // and, if it too needs the locked mailbox, parks its own run. Skipping it
    // dropped every email that arrived during the wait. Genuinely concurrent
    // runs are still kept apart by the routine lock.
    if (!opts.mailboxWaitRunId && !opts.triggerEvent) {
      const { pendingMailboxWait, MAILBOX_WAIT_SKIP_REASON } = await import(
        "~/modules/agent/routines/routine-mailbox-wait"
      )
      if (await pendingMailboxWait(opts.orgId, routine.id)) {
        const runId = await writeRunRow(opts.orgId, routine.id, "skipped_overlap", {
          error: MAILBOX_WAIT_SKIP_REASON,
          tick: opts,
        })
        return { status: "skipped_overlap", runId }
      }
    }

    // Scope drift
    const loadScopes = opts.loadOwnerScopes ?? defaultLoadOwnerScopes
    const ownerScopes = await loadScopes(opts.orgId, routine.ownerUserId)
    // Scope drift, and an owner agent that can call nothing it needs
    // (`routineScopeGap`): skipped loudly, with a run row and a pause.
    const scopeGap = await applyRoutineScopeCheck(opts.orgId, routine, ownerScopes)
    if (scopeGap) {
      const runId = await writeRunRow(opts.orgId, routine.id, "skipped_scope_mismatch", {
        error: scopeGap,
        tick: opts,
      })
      await emitRunSkipped(opts, routine, runId, "skipped_scope_mismatch", scopeGap)
      return { status: "skipped_scope_mismatch", runId }
    }

    // WHERE THE RUN HAPPENS (S21, D9, A50/F8, A57). Decided after the scope
    // pre-checks and before the credit one: a node runs on its owner's own
    // Claude sign-in, so the org's cloud credits gate only a cloud run. A
    // routine set to run on its owner's node becomes a node job instead of a
    // cloud turn, and its run row says `dispatched` until that job ends (the
    // job settles it, and only then completes a one-shot routine).
    const located = await planTickLocation(opts, routine)
    if ("result" in located) return located.result
    const { plan } = located

    // Credit pre-check, for a cloud run only. A `node_else_cloud` routine with
    // no live node lands here too: out of credits it does not fall back (no
    // `fell_back` job, which records a run that went to the cloud) and is
    // skipped and paused like any cloud routine.
    // A flow spends model tokens only in its agent steps: a flow whose first leg (up to its
    // first wait) has none runs with no model and no credits, and the credit gate is made again
    // when a run resumes before an agent step (`flowLegNeedsCredits`, flow-runner.ts).
    const spendsTokens = !routine.flow || flowLegNeedsCredits(routine.flow.steps, 0)
    if (plan.where === "cloud" && spendsTokens) {
      const refusal = await applyRoutineCreditCheck(opts.orgId, routine, opts.checkCredits)
      if (refusal) {
        const runId = await writeRunRow(opts.orgId, routine.id, "skipped_no_credits", {
          error: refusal,
          tick: opts,
        })
        await emitRunSkipped(opts, routine, runId, "skipped_no_credits", refusal)
        return { status: "skipped_no_credits", runId }
      }
    } else if (creditPaused) {
      // A node run, or a flow leg with no agent step, spends no cloud credits: the credit
      // pause does not hold for it.
      await resumeSystemPausedRoutine(opts, routine, "paused_no_credits")
    }

    // Output thread
    const { threadId: outputThreadId, recreated } = await ensureOutputThread(opts.orgId, routine)

    // A FLOW routine (0303) runs its steps here, after the same checks: actions without an
    // agent, waits, agent steps (flow-runner.ts). A legacy routine (no flow) goes on below.
    if (routine.flow) {
      const { runFlow } = await import("~/modules/agent/routines/flow-runner")
      return await runFlow({
        orgId: opts.orgId,
        routine,
        ownerScopes,
        runScopes: routineRunScopes(routine.scopes ?? [], ownerScopes),
        outputThreadId,
        tick: opts,
        deps: {
          ...(opts.agentInvoker ? { agentInvoker: opts.agentInvoker } : {}),
          ...opts.flowDeps,
        },
      })
    }

    if (plan.where === "node") return dispatchToNode(opts, routine, outputThreadId)
    if (plan.fellBack) {
      const { recordRoutineFallback } = await import("~/modules/nodes/routine-dispatch")
      await recordRoutineFallback(nodeRunInput(opts, routine, outputThreadId))
    }

    // Agent invocation
    const startedAt = Date.now()
    await emitRunStarted(opts, routine, startedAt)
    const tickRunId = crypto.randomUUID()
    // The conversation the routine posts to says that it runs (routine-report.ts).
    const runLineId = await postRunStarted({
      orgId: opts.orgId,
      routine,
      outputThreadId,
      runKey: tickRunId,
      ownerScopes,
    })
    let agentError: string | null = null
    let turnsAdded = 0
    // Token budget + hard limit (S17): the budget is said in the prompt, the
    // limit rides on the tick frame as a shared account every turn of the
    // tick (and every agents_ask sub-run it starts) adds its tokens to. A run
    // that pauses keeps it for its resume (routine-run-resume.ts).
    const tokenAccount = createRunTokenAccount(routine)
    // Whose server-managed mailbox this tick may read: its owner's, and only
    // when the routine and this run of it are the owner's own doing.
    const mailboxReader = routineMailboxReader(routine, opts.requestedByUserId)
    // A read of the owner's locked private mailbox leaves its mark here, and
    // the run then waits for the owner (routine-mailbox-wait.ts). A run the
    // owner started with Run now carries their browser's nonce instead.
    const { newMailboxWaitSignal, parkRunForMailbox } = await import(
      "~/modules/agent/routines/routine-mailbox-wait"
    )
    const mailboxWait = mailboxReader && !opts.mailboxTurnNonce ? newMailboxWaitSignal() : undefined
    try {
      const invoker: NonNullable<RoutineTickOpts["agentInvoker"]> =
        opts.agentInvoker ?? defaultAgentInvoker
      // Enter a routine-tick run frame so routine-only kernel tools
      // (watch_state / web_watch) see `routineId` via currentRunContext() and
      // are surfaced by buildToolSet for this tick only. The runId is the tick's
      // own root; nested agent runs inherit/override deeper frames as needed.
      const result = await runContextStore.run(
        {
          runId: tickRunId,
          parentRunId: null,
          rootRunId: tickRunId,
          nestingDepth: 0,
          background: true,
          routineId: opts.routineId,
          routineRunId: tickRunId,
          ...(routine.followUp ? { routineFollowUp: true } : {}),
          ...(opts.triggerEvent?.hop ? { eventHop: opts.triggerEvent.hop } : {}),
          ...(tokenAccount ? { tokenAccount } : {}),
          ...(mailboxReader ? { routineMailboxReaderUserId: mailboxReader } : {}),
          ...(mailboxWait ? { routineMailboxWait: mailboxWait } : {}),
          ...(mailboxReader && opts.mailboxTurnNonce
            ? { mailboxTurnNonce: opts.mailboxTurnNonce }
            : {}),
          ...(mailboxReader && opts.mailboxTurnNonce && opts.mailboxHandoff
            ? { mailboxHandoff: opts.mailboxHandoff }
            : {}),
        },
        () =>
          invoker({
            orgId: opts.orgId,
            ownerUserId: routine.ownerUserId,
            threadId: outputThreadId,
            prompt: withReportSentence(withTokenBudgetSentence(routine.prompt, routine), routine),
            scopes: routineRunScopes(routine.scopes ?? [], ownerScopes),
            triggerEvent: opts.triggerEvent,
          }),
      )
      turnsAdded = result.turnsAdded
      // The tick returned, but could not do its job: recorded as a failure,
      // so the run history, the owner's alert, the incident and the
      // reconciler all see it (a blocked tick used to read "succeeded").
      if (result.failure) agentError = result.failure
    } catch (err) {
      agentError = err instanceof Error ? err.message : String(err)
    }
    // A run whose turn parked a gated call waits for the decision instead of
    // ending: it resumes, in this same run, with the call's real result
    // (routine-run-resume.ts). Its summary waits for the real end.
    // A turn that, waiting, wrote "Blocked: ..." waits too: that is the pause.
    // So does a turn that stopped (without an error) before its final answer.
    if (
      agentError === null ||
      agentError.startsWith(REPORTED_BLOCKED) ||
      agentError.startsWith(TURN_STOPPED_EARLY)
    ) {
      const { pauseRunIfWaiting } = await import("~/modules/agent/routines/routine-run-resume")
      const paused = await pauseRunIfWaiting({
        orgId: opts.orgId,
        routine,
        tickRunId,
        outputThreadId,
        recreated,
        startedAt,
        runLineId,
        turnsAdded,
        trigger: routineRunTrigger(opts).trigger,
        tick: opts,
        runFrame: { tokenAccount },
      })
      if (paused) {
        await clearEventInFlight(routine.id, opts.triggerEvent?.eventId)
        return paused
      }
    }
    // The turn needed the owner's private mailbox and nobody could open it:
    // the run waits for the owner's Run now instead of ending.
    if (mailboxWait?.needed) {
      await clearEventInFlight(routine.id, opts.triggerEvent?.eventId)
      return parkRunForMailbox({
        orgId: opts.orgId,
        routine,
        signal: mailboxWait,
        outputThreadId,
        startedAt,
        runLineId,
        tick: opts,
        turnsAdded,
      })
    }
    // A follow-up run does not wait for what it staged: it ends, and its line
    // says how many drafts wait for a person.
    const draftsWaiting =
      routine.followUp && agentError === null
        ? await (
            await import("~/modules/agent/routines/routine-run-resume")
          ).undecidedApprovalCount(opts.orgId, tickRunId)
        : 0
    return finishRun({
      orgId: opts.orgId,
      routine,
      outputThreadId,
      recreated,
      startedAt,
      runLineId,
      ownerScopes,
      agentError,
      turnsAdded,
      ...(draftsWaiting > 0 ? { draftsWaiting } : {}),
      ...(opts.mailboxWaitRunId ? { runId: opts.mailboxWaitRunId } : {}),
      requestedByUserId: opts.requestedByUserId,
      trigger: routineRunTrigger(opts).trigger,
      eventEntityId: opts.triggerEvent?.entityId ?? null,
      eventId: opts.triggerEvent?.eventId ?? null,
      tick: opts,
    })
  } finally {
    stopHeartbeat()
    try {
      // Atomic compare-and-delete: only release the lock if we still own it.
      // GET-then-DEL is a TOCTOU race; the Lua script makes it atomic.
      const releaseLua = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `
      await redis.eval(releaseLua, 1, lockKey, lockToken)
    } catch (err) {
      log.warn({ err, routineId: opts.routineId }, "Failed to release routine lock")
    }
  }
}

/** How a run ends, for {@link finishRun}: a tick that ran through, or a paused run that resumed. */
interface RunEnd {
  orgId: string
  routine: typeof routines.$inferSelect
  outputThreadId: string
  recreated: boolean
  /** When the run started (ms): the report reads the replies since then. */
  startedAt: number
  runLineId: string | null
  ownerScopes: string[]
  agentError: string | null
  turnsAdded: number
  requestedByUserId?: string
  trigger: RoutineRunTrigger
  eventEntityId: string | null
  eventId?: string | null
  /** Read the report from the replies since then (ms); default `startedAt`. */
  reportSince?: number
  /** The run row a paused run already has; absent, the row is written here. */
  runId?: string
  /** The tick's options, for a row written here. */
  tick?: Pick<RoutineTickOpts, "triggerEvent" | "requestUuid">
  /** A follow-up run's drafts still waiting for a person: its line says how many. */
  draftsWaiting?: number
}

/**
 * The end of a run, once: its summary in the report conversation, its run
 * line settled, its run row, the routine's last-run fields, the incident, the
 * one-shot completion, the live event, the owner's alert, the run-now
 * requester's notice and the episode close. A run that paused on an approval
 * reaches this only when it resumed and ended (routine-run-resume.ts).
 */
export async function finishRun(end: RunEnd): Promise<RoutineTickResult> {
  const { orgId, routine, outputThreadId, recreated, startedAt, runLineId, ownerScopes } = end
  const { agentError, turnsAdded } = end
  const durationMs = Date.now() - startedAt
  const status: RoutineRunStatus = agentError
    ? "failed"
    : recreated
      ? "output_thread_recreated"
      : "succeeded"
  // A paused run ends once: its row moves from `waiting_approval` first, and a
  // second ender (a resume and the sweep) finds it ended and posts nothing.
  if (
    end.runId &&
    !(await settleRunRow(orgId, end.runId, status, { durationMs, error: agentError, turnsAdded }))
  ) {
    return { status: "no_run", runId: end.runId }
  }
  // The routine reports back to the conversation it was asked for in: its
  // final reply is posted there as the routine (routine-report.ts). Only a
  // run that did its job reports; a failed one alerts the owner below.
  const report =
    agentError === null && routine.reportThreadId
      ? await deliverRoutineReport({
          orgId,
          routine,
          outputThreadId,
          since: new Date(end.reportSince ?? startedAt),
          ownerScopes,
        })
      : null
  await settleRunStarted(
    orgId,
    runLineId,
    agentError ? "failed" : "succeeded",
    end.draftsWaiting ? { draftsWaiting: end.draftsWaiting } : undefined,
  )
  const runId = end.runId
    ? end.runId
    : await writeRunRow(orgId, routine.id, status, {
        durationMs,
        error: agentError ?? undefined,
        turnsAdded,
        tick: end.tick,
        startedAt: new Date(startedAt),
      })
  await clearEventInFlight(routine.id, end.eventId)
  // A one-shot (scheduled) routine terminates in `completed` after a
  // successful run. Key off `agentError === null` — a successful run can end
  // `output_thread_recreated`, which must still complete the one-shot. A
  // failed one-shot stays `active` so a BullMQ retry can re-run it.
  const oneShotCompleted = routine.kind === "scheduled" && agentError === null
  await withPrivilegedDb(orgId, "routine-bump-last-run", (tx) =>
    tx
      .update(routines)
      .set({
        lastRunAt: new Date(),
        lastRunStatus: agentError ? "failed" : "succeeded",
        lastRunError: agentError,
        ...(oneShotCompleted ? { status: "completed" as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(routines.id, routine.id)),
  )
  // An event the routine could not handle is an incident on the monitoring
  // board, one per routine however many events failed; the routine's next
  // successful run resolves it (routine-incident.ts). Never throws.
  {
    const { reportRoutineRunIncident } = await import("~/modules/agent/routines/routine-incident")
    await reportRoutineRunIncident({
      orgId: orgId,
      routine,
      status,
      error: agentError,
      trigger: end.trigger,
      previousStatus: routine.lastRunStatus ?? null,
    })
  }
  if (oneShotCompleted) {
    // Flip the UI badge to "Done".
    await emitRoutineEvent(orgId, routine.ownerUserId, routine.ownerAgentId, routine.id, "status", {
      status: "completed",
      ranAt: new Date().toISOString(),
    })
  }
  // Notify UI: routines store updates last-run indicator + run history panel.
  // Payload wraps the run row under `run` to match the client's
  // RoutineRunCompletedMessage schema (`msg.run.ranAt`, etc.) — keep the
  // top-level fields too for backwards-compat with any listeners that
  // read them directly.
  const ranAt = new Date().toISOString()
  await emitRoutineEvent(
    orgId,
    routine.ownerUserId,
    routine.ownerAgentId,
    routine.id,
    "run_completed",
    {
      run: {
        id: runId,
        routineId: routine.id,
        ranAt,
        status,
        durationMs,
        errorMessage: agentError,
        eventEntityId: end.eventEntityId,
      },
      runId,
      status,
      routineName: routine.name,
      eventEntityId: end.eventEntityId,
      durationMs,
      turnsAdded,
      outputThreadRecreated: recreated,
      ranAt,
      error: agentError,
    },
  )
  // UX gap fix: a run-now's output lands only in the routine's output thread —
  // to a requester who isn't watching that thread, an approved run-now looks
  // like it never happened. When this tick was a manual run-now
  // (`end.requestedByUserId` set), notify the requester via the same
  // attention-feed mechanism `notify_user` uses, linking straight to the
  // output thread. Best-effort: never fail the tick over a notification.
  // D21: a failed run tells the routine's OWNER on Home, whatever started it
  // (a scheduled tick used to tell nobody). One row per routine, filed under
  // "Routines failed or paused" (routine-alert.ts).
  if (agentError) {
    try {
      await withPrivilegedDb(orgId, "routine-run-failed-notify-owner", (tx) =>
        queueRoutineAlert(tx, {
          orgId: orgId,
          routine: { ...routine, outputThreadId },
          status: "failed",
          error: agentError,
        }),
      )
    } catch (err) {
      log.error(
        { err, routineId: routine.id },
        "Failed to notify the owner of a failed routine run",
      )
    }
  }
  // The owner's own failed run-now is already the alert above: one item, not two.
  const requesterAlreadyAlerted =
    agentError !== null && end.requestedByUserId === routine.ownerUserId
  // A requester who sits in the report conversation just got the run's
  // result there, with its unread state and push: a "finished running" item
  // on top of it would be the same news twice.
  const requesterGotReport =
    !!end.requestedByUserId && !!report?.reachedUserIds.includes(end.requestedByUserId)
  if (end.requestedByUserId && !requesterAlreadyAlerted && !requesterGotReport) {
    try {
      await withPrivilegedDb(orgId, "routine-run-now-notify-requester", async (tx) => {
        await tx.queueEvent({
          app: "kernel",
          entity: "agent_notification",
          action: "create",
          entityId: crypto.randomUUID(),
          data: {
            summary: agentError
              ? `Routine "${routineDisplayName(routine)}" run failed`
              : `Routine "${routineDisplayName(routine)}" finished running`,
            urgency: agentError ? 60 : 30,
            targetUserIds: [end.requestedByUserId],
            link: { tabType: "thread", entityId: outputThreadId },
          },
          actorId: routine.ownerUserId,
          actorType: "system",
          // A11 — same identity as the run_completed row above, from the same
          // routine row already in hand: this notification is part of the same
          // agent turn. Explicit, so a run-now that arrives inside somebody
          // else's live frame still records the routine's agent, and a routine
          // with no owner agent records null rather than the requester.
          agentId: routine.ownerAgentId ?? null,
          orgId: orgId,
          timestamp: new Date().toISOString(),
        })
      })
    } catch (err) {
      log.error(
        { err, routineId: routine.id, requestedByUserId: end.requestedByUserId },
        "Failed to notify run-now requester of completed routine run",
      )
    }
  }
  // TRIGGER (b), spec-memory.md "Routine ticks": a tick IS an episode, so its
  // end closes one. Enqueued rather than run here, so a slow consolidation
  // never holds the routine's lock, and a failure to enqueue costs the
  // episode file rather than the tick that just finished.
  if (routine.ownerAgentId && outputThreadId) {
    try {
      const { closeEpisode } = await import("~/modules/agent/memory/consolidation")
      await closeEpisode({
        orgId: orgId,
        agentId: routine.ownerAgentId,
        threadId: outputThreadId,
        closeReason: "routine-tick",
      })
    } catch (err) {
      log.error({ err, routineId: routine.id }, "Could not enqueue consolidation for this tick")
    }
  }
  return { status, runId, durationMs }
}
