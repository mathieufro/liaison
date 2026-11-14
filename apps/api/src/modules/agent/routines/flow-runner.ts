// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Routine flows (0303): a routine's ordered steps after its trigger.
 *
 * `runRoutineTick` (routine-worker.ts) hands a routine whose `flow` is set to `runFlow`, after the
 * same owner, scope, ceiling and credit checks a legacy tick gets. A legacy routine (`flow` null)
 * never reaches this file.
 *
 * - ACTION steps run without an agent, as the routine's OWNER: each is a tool call through
 *   `executeTool` (the trigger record's app's declared update / comment tool, kernel
 *   threads_create for a direct message) with the
 *   run's scopes (the routine's scopes bounded by the owner's, and by the owner agent's ceiling on
 *   the routine thread, exactly as a tick's tool calls), inside the routine's run frame, so a
 *   write is attributed to the routine ("Routine <name>") and never to the person, and a gated
 *   tool parks as an approval (the step `awaiting_approval`, never auto-approved). `notify` queues
 *   the attention pipeline's `kernel:agent_notification:create`.
 * - CONDITIONS (`if`, a wait's `until`) read the trigger record fresh, under the owner's RLS, through
 *   its app's declared reader (flow-records.ts; a project task): a record the owner cannot read, or
 *   an entity that declares no flow record, makes every condition false.
 * - WAIT steps compute a deadline in working time (lib/working-time.ts), park the run (`waiting`)
 *   and enqueue `kernel:routine-flow-resume` with that delay. A newer run for the same record
 *   supersedes a waiting one (it ends `skipped_condition`, "superseded").
 * - AGENT steps run the routine's agent invoker with the step's prompt; required outcomes are
 *   checked after the turn, a missing one bumps the agent (at most `maxBumps`), and one still
 *   missing flags the run and tells the owner.
 *
 * Each step's state is written to `routine_runs.steps` after the step (one UPDATE per step).
 */
import crypto from "node:crypto"
import type {
  RoutineFlow,
  RoutineFlowCondition,
  RoutineFlowOutcome,
  RoutineFlowStep,
} from "@liaison/shared"
import { and, eq, inArray } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { routineRuns, routines } from "~/db/schema/kernel"
import type { RoutineRunFlowContext, RoutineRunStepState } from "~/db/schema/kernel/routine-runs"
import { taskCellMatches } from "~/infra/jobs/event-routine-gate"
import { rootLogger } from "~/lib/logger"
import { addWorkingTime, resolveWorkingCalendar, type WorkingCalendar } from "~/lib/working-time"
import { routineDisplayName } from "~/modules/agent/routines/routine-label"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import {
  type FlowRecord,
  type FlowRecordSource,
  flowRecordPath,
  flowRecordSource,
  flowRecordSourceOfLabel,
  flowRecordTool,
  readFlowRecordLoad,
  readFlowRecords,
} from "./flow-records"
import type {
  RoutineRunStatus,
  RoutineTickOpts,
  RoutineTickResult,
  RoutineTriggerEvent,
} from "./routine-worker"

const log = rootLogger.child({ module: "routine-flow" })

type RoutineRow = typeof routines.$inferSelect

export const FLOW_RESUME_JOB = "routine-flow-resume"
const DEFAULT_MAX_BUMPS = 2

/** What `runFlow` needs from the tick that started it. */
export interface FlowRunInput {
  orgId: string
  routine: RoutineRow
  ownerScopes: string[]
  /** The routine's scopes bounded by the owner's (routine-worker.ts `routineRunScopes`). */
  runScopes: string[]
  outputThreadId: string
  tick: Pick<RoutineTickOpts, "triggerEvent" | "requestUuid" | "requestedByUserId">
  deps?: FlowDeps
}

/** Seams tests replace. */
export interface FlowDeps {
  agentInvoker?: RoutineTickOpts["agentInvoker"]
  /** A resume's credit gate, before a remaining agent step (default: the tick's default). */
  checkCredits?: RoutineTickOpts["checkCredits"]
  /** A resume's owner scopes (default: the owner's effective permissions). */
  loadOwnerScopes?: (orgId: string, userId: string) => Promise<string[]>
  /** Arms the wait's resume job (default: the kernel job, delayed, jobId per routine+record+step). */
  enqueueResume?: (
    payload: FlowResumePayload,
    opts: { delayMs: number; jobId: string },
  ) => Promise<void>
  /** Runs one tool call as the owner (default: `executeTool`). */
  callTool?: (call: FlowToolCall) => Promise<FlowToolResult>
  now?: () => Date
}

export interface FlowResumePayload {
  orgId: string
  routineId: string
  runId: string
  stepId: string
  /** How many times the job found the record's lock held (runFlowResumeJob). */
  lockRetries?: number
  /** How many times the wait fired early and re-armed (`resumeFlowWait`). */
  rearms?: number
}

export interface FlowToolCall {
  toolName: string
  orgId: string
  actor: UserContext
  params: Record<string, unknown>
  threadId: string
}
export type FlowToolResult =
  | { ok: true; data: unknown }
  | { blocked: { approvalRequestId: string | null } }
  | { error: string }

/** The trigger record (a task) as a condition, an action or a message reads it. */
interface FlowTask {
  id: string
  projectId: string
  statusId: string | null
  assigneeId: string | null
  assigneeName: string | null
  title: string
  key: string | null
  fields: Record<string, unknown>
  statusEnteredAt: string | null
}

/** One run's working state. */
interface FlowRun {
  orgId: string
  routine: RoutineRow
  flow: RoutineFlow
  runId: string
  steps: RoutineRunStepState[]
  startedAt: number
  /** When the trigger fired (the run's start): `status_unchanged_since_trigger` compares to it. */
  triggerAt: Date
  /** The trigger record's id (a task id for a project task event), or null. */
  entityId: string | null
  /** The trigger entity's declared flow record (flow-records.ts), or null: it has none. */
  record: FlowRecordSource | null
  outputThreadId: string
  actor: UserContext
  agentId: string | null
  agentCeiling: string[] | null
  hop: number
  triggerEvent?: RoutineTriggerEvent
  deps: FlowDeps
}

// ── Entry ────────────────────────────────────────────────────────────────────

/** Runs a flow routine's tick: a new run row, then its steps from the first. */
export async function runFlow(input: FlowRunInput): Promise<RoutineTickResult> {
  const { orgId, routine } = input
  const flow = routine.flow
  if (!flow) throw new Error("runFlow: the routine has no flow")
  const ev = input.tick.triggerEvent
  const deps = input.deps ?? {}
  const now = deps.now?.() ?? new Date()
  const entityId = ev?.entityId ?? null
  await ensureOrgApps(orgId)
  if (entityId) await supersedeWaitingRuns(orgId, routine.id, entityId)

  const steps: RoutineRunStepState[] = flow.steps.map((s) => ({
    id: s.id,
    type: s.type,
    state: "pending",
    startedAt: null,
    endedAt: null,
    note: null,
  }))
  const { writeRunRow } = await import("./routine-worker")
  const runId = await writeRunRow(orgId, routine.id, "running", {
    tick: input.tick,
    startedAt: now,
    steps,
    flowContext: {
      flowHash: flowHash(flow),
      hop: ev?.hop ?? 0,
      triggerEvent: ev ?? null,
    },
  })
  const base = {
    orgId,
    routine,
    flow,
    runId,
    steps,
    startedAt: now.getTime(),
    triggerAt: now,
    entityId,
    record: flowRecordSource(orgId, ev?.app, ev?.entity),
    outputThreadId: input.outputThreadId,
    hop: ev?.hop ?? 0,
    triggerEvent: ev,
    deps,
  }
  const bare = bareRun(base)
  // A throw anywhere past the row ends the run `failed`, never left `running`.
  try {
    const run = await buildRun({ ...base, runScopes: input.runScopes })
    // A task event whose task the owner cannot read (now): nothing runs, and nothing it holds
    // leaks into a step's note. The run ends `skipped_condition`.
    if (run.record && run.entityId && !(await readTriggerTask(run))) {
      for (const s of run.steps) {
        setState(s, "skipped", "The routine's owner cannot read the task that triggered it.")
      }
      return await endFlowRun(run, "skipped_condition", null)
    }
    return await continueFlow(run, 0)
  } catch (err) {
    return failRun(bare, err)
  }
}

/** Pure: a flow's hash, over its canonical JSON (key order never changes it). */
export function flowHash(flow: RoutineFlow): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canon(flow)))
    .digest("hex")
}

/** A run as far as ending it goes: no scope resolved, no tool call possible. */
function bareRun(a: Omit<FlowRun, "actor" | "agentId" | "agentCeiling">): FlowRun {
  return {
    ...a,
    actor: {
      actorType: "user",
      userId: a.routine.ownerUserId,
      orgId: a.orgId,
      scopes: [],
      dimensionGrants: {},
    },
    agentId: null,
    agentCeiling: null,
  }
}

/**
 * A run that holds its row (`running`) threw: it ends `failed` with the error, so no row is left
 * `running` with nothing behind it (the sweep is the backstop).
 */
async function failRun(run: FlowRun, err: unknown): Promise<RoutineTickResult> {
  const message = err instanceof Error ? err.message : String(err)
  log.error({ err, routineId: run.routine.id, runId: run.runId }, "flow run failed")
  for (const s of run.steps) {
    if (s.state === "running" || s.state === "waiting" || s.state === "awaiting_approval") {
      setState(s, "failed", `Failed: ${message}`)
    }
  }
  try {
    return await endFlowRun(run, "failed", `The run failed: ${message}`)
  } catch (endErr) {
    log.error({ err: endErr, runId: run.runId }, "flow run: the failed end was not written")
    return { status: "failed", runId: run.runId }
  }
}

async function buildRun(
  a: Omit<FlowRun, "actor" | "agentId" | "agentCeiling"> & { runScopes: string[] },
): Promise<FlowRun> {
  // The scope the run's tool calls hold: resolved as a tick's turn resolves it (the routine's
  // owner agent, its ceiling on the routine thread, bounded by the routine's scopes).
  const { resolveTurnScope } = await import("~/modules/agent/runtime/agent-service")
  const turn = await withPrivilegedDb(a.orgId, "routine-flow-scope", (tx) =>
    resolveTurnScope(
      tx,
      a.orgId,
      a.outputThreadId,
      { userId: a.routine.ownerUserId, scopes: a.runScopes },
      a.routine.id,
    ),
  )
  const { resolveRoutineOwnerDimensionGrants } = await import("~/infra/jobs/kernel-jobs")
  const dimensionGrants = await resolveRoutineOwnerDimensionGrants(a.orgId, a.routine.ownerUserId)
  const { runScopes: _runScopes, ...rest } = a
  return {
    ...rest,
    actor: {
      actorType: "user",
      userId: a.routine.ownerUserId,
      orgId: a.orgId,
      scopes: turn ? turn.effectiveScope : a.runScopes,
      dimensionGrants,
    },
    agentId: turn?.agentId ?? null,
    agentCeiling: turn?.agentCeiling ?? null,
  }
}

/** The run frame every step's work happens in: the routine's, so writes are attributed to it. */
function inRunFrame<T>(run: FlowRun, fn: () => Promise<T>): Promise<T> {
  return runContextStore.run(
    {
      runId: run.runId,
      parentRunId: null,
      rootRunId: run.runId,
      nestingDepth: 0,
      background: true,
      routineId: run.routine.id,
      routineRunId: run.runId,
      ...(run.hop > 0 ? { eventHop: run.hop } : {}),
      ...(run.agentId && run.agentCeiling
        ? { agentId: run.agentId, agentCeiling: run.agentCeiling }
        : {}),
    },
    fn,
  )
}

// ── The step loop ───────────────────────────────────────────────────────────

type StepOutcome =
  | { kind: "next" }
  | { kind: "end"; status: RoutineRunStatus; error: string | null }
  | { kind: "park"; status: "waiting" | "waiting_approval" }

/** Runs the flow's steps from `from` until it ends or parks. */
async function continueFlow(run: FlowRun, from: number): Promise<RoutineTickResult> {
  let flagged: string | null = null
  for (let i = from; i < run.flow.steps.length; i++) {
    const step = run.flow.steps[i]!
    const state = run.steps[i]!
    let outcome: StepOutcome
    try {
      outcome = await runStep(run, step, state)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(
        { err, routineId: run.routine.id, runId: run.runId, stepId: step.id },
        "flow step failed",
      )
      setState(state, "failed", `Failed: ${message}`)
      outcome = { kind: "end", status: "failed", error: `Step ${step.id} failed: ${message}` }
    }
    if (state.state === "flagged") flagged = state.note
    await saveSteps(run)
    if (outcome.kind === "park") {
      await setRunStatus(run, outcome.status)
      await clearInFlight(run)
      return { status: outcome.status, runId: run.runId }
    }
    if (outcome.kind === "end") return endFlowRun(run, outcome.status, outcome.error)
  }
  return endFlowRun(run, flagged ? "flagged" : "succeeded", flagged)
}

function setState(
  s: RoutineRunStepState,
  state: RoutineRunStepState["state"],
  note: string | null,
  output?: Record<string, unknown>,
): void {
  const at = new Date().toISOString()
  if (!s.startedAt) s.startedAt = at
  s.state = state
  s.note = note
  if (output) s.output = { ...(s.output ?? {}), ...output }
  if (state !== "running" && state !== "waiting" && state !== "awaiting_approval") s.endedAt = at
}

async function runStep(
  run: FlowRun,
  step: RoutineFlowStep,
  state: RoutineRunStepState,
): Promise<StepOutcome> {
  setState(state, "running", null)
  if ("if" in step && step.if) {
    const task = await readTriggerTask(run)
    if (!evaluateCondition(step.if, task, run.triggerAt)) {
      setState(state, "skipped", "Its condition did not hold.")
      return { kind: "next" }
    }
  }
  if (step.type === "action") return runAction(run, step, state)
  if (step.type === "wait") return armWait(run, step, state)
  return runAgentStep(run, step, state)
}

// ── Conditions ──────────────────────────────────────────────────────────────

const isEmptyCell = (cell: unknown) =>
  cell === undefined || cell === null || cell === "" || (Array.isArray(cell) && cell.length === 0)

function conditionField(task: FlowTask, field: string): unknown {
  if (field === "status") return task.statusId
  if (field === "assignee") return task.assigneeId
  return task.fields[field.slice("fields.".length)]
}

/** Pure: does the condition hold for the task (null: the owner cannot read it, so nothing holds)? */
export function evaluateCondition(
  c: RoutineFlowCondition,
  task: FlowTask | null,
  triggerAt: Date,
): boolean {
  if ("all" in c) return c.all.every((x) => evaluateCondition(x, task, triggerAt))
  if ("any" in c) return c.any.some((x) => evaluateCondition(x, task, triggerAt))
  if (!task) return false
  if (c.op === "status_unchanged_since_trigger") {
    if (!task.statusEnteredAt) return false
    return new Date(task.statusEnteredAt).getTime() <= triggerAt.getTime()
  }
  const cell = conditionField(task, c.field)
  if (c.op === "empty") return isEmptyCell(cell)
  if (c.op === "not_empty") return !isEmptyCell(cell)
  const values = Array.isArray(c.value) ? c.value : [c.value]
  return values.some((v) => taskCellMatches(cell, v ?? null))
}

/** The org's app registries, set up before a declaration is read (job dispatch has done it). */
async function ensureOrgApps(orgId: string): Promise<void> {
  const { awaitOrgApps } = await import("~/modules/apps/init")
  await awaitOrgApps(orgId)
}

function asFlowTask(r: FlowRecord): FlowTask {
  return {
    id: r.id,
    projectId: r.containerId,
    statusId: r.statusId,
    assigneeId: r.assigneeId,
    assigneeName: r.assigneeName,
    title: r.title,
    key: r.key,
    fields: r.fields,
    statusEnteredAt: r.statusEnteredAt,
  }
}

/** The trigger record, read now under the owner's RLS; null when there is none or it is hidden. */
async function readTriggerTask(run: FlowRun): Promise<FlowTask | null> {
  if (!run.record || !run.entityId) return null
  const entityId = run.entityId
  try {
    const [t] = await readFlowRecords(run.record, run.actor, [entityId])
    return t ? asFlowTask(t) : null
  } catch (err) {
    // A read the owner may not make (no scope on the record's app) is the same as a hidden record.
    log.warn(
      { err, routineId: run.routine.id, taskId: entityId },
      "flow: trigger task not readable",
    )
    return null
  }
}

// ── Text ────────────────────────────────────────────────────────────────────

function cellText(cell: unknown): string {
  if (cell === undefined || cell === null) return ""
  if (Array.isArray(cell)) return cell.map(cellText).join(", ")
  if (typeof cell === "object") {
    const o = cell as { label?: unknown; name?: unknown; id?: unknown }
    return String(o.label ?? o.name ?? o.id ?? "")
  }
  return String(cell)
}

/** Pure: fills {{task.title}}, {{task.key}}, {{task.url}}, {{task.assigneeName}}, {{task.fields.<key>}}. */
export function interpolateFlowText(
  text: string,
  task: FlowTask | null,
  baseUrl = "",
  record: FlowRecordSource | null = null,
): string {
  return text.replace(
    /\{\{\s*task\.([a-zA-Z]+)(?:\.([a-z][a-z0-9_]*))?\s*\}\}/g,
    (_, prop, key) => {
      if (!task) return ""
      if (prop === "title") return task.title
      if (prop === "key") return task.key ?? ""
      if (prop === "url") {
        return record ? `${baseUrl.replace(/\/$/, "")}${flowRecordPath(record, task.id)}` : ""
      }
      if (prop === "assigneeName") return task.assigneeName ?? ""
      if (prop === "fields" && key) return cellText(task.fields[key])
      return ""
    },
  )
}

function resolvePerson(ref: string, run: FlowRun, task: FlowTask | null): string | null {
  if (ref === "{{owner}}") return run.routine.ownerUserId
  if (ref === "{{task.assigneeId}}") return task?.assigneeId ?? null
  return ref
}

/** The org's link base, read only when the text asks for {{task.url}}. */
async function taskBaseUrl(run: FlowRun, text: string): Promise<string> {
  if (!/\{\{\s*task\.url\s*\}\}/.test(text)) return ""
  const { orgPublicBaseUrl } = await import("~/lib/org-public-url")
  return orgPublicBaseUrl(run.orgId)
}

/** The org's working calendar (its time zone and business hours), the flow's override on top. */
async function loadOrgWorkingCalendar(
  orgId: string,
  override: Partial<WorkingCalendar> | null,
): Promise<WorkingCalendar> {
  const { organizations } = await import("~/db/schema/kernel")
  const [org] = await withPrivilegedDb(orgId, "routine-flow-calendar", (tx) =>
    tx
      .select({ timezone: organizations.timezone, businessHours: organizations.businessHours })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  return resolveWorkingCalendar(org ?? null, override)
}

// ── Actions ─────────────────────────────────────────────────────────────────

type ActionStep = Extract<RoutineFlowStep, { type: "action" }>

/**
 * The scope a `notify` step needs to notify anyone but the routine's owner. The attention event
 * itself asks for none (`notify_user` is self-targeted), so notifying a teammate about a record
 * takes the right to act on it: the scope its app declares (`routineFlow.notifyScope`, a project
 * task's `projects:tasks:write`). A run with no trigger record has none: it notifies its owner only.
 */
function notifyOthersScope(run: FlowRun): string | null {
  return run.record?.decl.notifyScope ?? null
}

/**
 * Why a `notify` step may not reach its targets, or null. The owner alone is always allowed (the
 * same as `notify_user`). Anyone else must be an active member of the org, the run must hold
 * the record's notify scope, and each target must be able to read the trigger task under their
 * own grants and RLS: the summary carries the task's title and fields.
 */
async function notifyRefusal(
  run: FlowRun,
  targets: string[],
  task: FlowTask | null,
): Promise<string | null> {
  const others = targets.filter((t) => t !== run.routine.ownerUserId)
  if (others.length === 0) return null
  const { isScopeCovered } = await import("~/modules/agent/scopes/scope-coverage")
  const scope = notifyOthersScope(run)
  if (!scope) {
    return "Notifying someone other than the routine's owner needs a trigger record: this run has none."
  }
  if (!isScopeCovered([scope], run.actor.scopes)) {
    return `Notifying someone other than the routine's owner needs the scope ${scope}, which this routine does not hold.`
  }
  const { users } = await import("~/db/schema/kernel")
  const active = await withPrivilegedDb(run.orgId, "routine-flow-notify-targets", (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.orgId, run.orgId),
          inArray(users.id, others),
          eq(users.status, "active"),
          eq(users.userType, "member"),
        ),
      ),
  )
  const activeIds = new Set(active.map((u) => u.id))
  const notMembers = others.filter((t) => !activeIds.has(t))
  if (notMembers.length > 0) {
    return `Cannot notify ${notMembers.join(", ")}: not an active member of this organization.`
  }
  if (!task) return null
  const blind: string[] = []
  for (const userId of others) {
    if (!(await userCanReadTask(run, userId, task.id))) blind.push(userId)
  }
  if (blind.length > 0) {
    return `Cannot notify ${blind.join(", ")}: they cannot read the task that triggered the routine.`
  }
  return null
}

/** Whether a member can read the task, under their own grants and RLS. */
async function userCanReadTask(run: FlowRun, userId: string, taskId: string): Promise<boolean> {
  const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
  const perms = await withPrivilegedDb(run.orgId, "routine-flow-notify-perms", (tx) =>
    loadEffectivePermissions(tx, userId, run.orgId),
  )
  if (!run.record) return false
  try {
    const rows = await readFlowRecords(
      run.record,
      {
        actorType: "user",
        userId,
        orgId: run.orgId,
        scopes: perms.scopes,
        dimensionGrants: perms.dimensionGrants,
      },
      [taskId],
    )
    return rows.length > 0
  } catch (err) {
    log.warn({ err, routineId: run.routine.id, userId, taskId }, "flow: notify target read check")
    return false
  }
}

async function defaultCallTool(call: FlowToolCall): Promise<FlowToolResult> {
  const { executeTool } = await import("~/modules/apps/execute-tool")
  try {
    const res = await executeTool({
      toolName: call.toolName,
      orgId: call.orgId,
      actor: call.actor,
      params: call.params,
      threadId: call.threadId,
      // A routine's action is the routine's agent acting, never the human UI: it gates like any
      // agent call (an approval, never auto-approved).
      origin: "in-app-agent",
      priority: "background",
    })
    if (res.blocked) {
      const blocked = res.blocked as { approvalRequestId?: string | null }
      return { blocked: { approvalRequestId: blocked.approvalRequestId ?? null } }
    }
    const data = res.data as { error?: { message?: string } | string } | null
    if (data && typeof data === "object" && "error" in data && data.error) {
      const e = data.error
      return { error: typeof e === "string" ? e : (e.message ?? "the tool returned an error") }
    }
    return { ok: true, data: res.data }
  } catch (err) {
    const e = err as { message?: string; code?: string }
    return { error: `${call.toolName}: ${e.code ? `${e.code}: ` : ""}${e.message ?? String(err)}` }
  }
}

async function callTool(
  run: FlowRun,
  toolName: string,
  params: Record<string, unknown>,
): Promise<FlowToolResult> {
  const call = run.deps.callTool ?? defaultCallTool
  return inRunFrame(run, () =>
    call({ toolName, orgId: run.orgId, actor: run.actor, params, threadId: run.outputThreadId }),
  )
}

/** The candidate holding the fewest open records of the container (ties: list order). */
async function leastLoaded(
  run: FlowRun,
  record: FlowRecordSource,
  containerId: string,
  candidates: string[],
): Promise<string> {
  const load = await readFlowRecordLoad(record, run.actor, containerId, candidates)
  let best = candidates[0]!
  for (const c of candidates) if ((load.get(c) ?? 0) < (load.get(best) ?? 0)) best = c
  return best
}

async function runAction(
  run: FlowRun,
  step: ActionStep,
  state: RoutineRunStepState,
): Promise<StepOutcome> {
  const task = await readTriggerTask(run)
  const fail = (note: string): StepOutcome => {
    setState(state, "failed", note)
    return { kind: "end", status: "failed", error: `Step ${step.id}: ${note}` }
  }
  const needsTask = step.action !== "message" && step.action !== "notify"
  const record = run.record
  if (needsTask && (!task || !record)) {
    return fail("The trigger task is not there, or the routine's owner cannot read it.")
  }

  if (step.action === "notify") {
    const targets = [
      ...new Set(
        step.args.to.map((ref) => resolvePerson(ref, run, task)).filter((id): id is string => !!id),
      ),
    ]
    if (targets.length === 0) return fail("Nobody to notify: the task has no assignee.")
    const refused = await notifyRefusal(run, targets, task)
    if (refused) return fail(refused)
    const summary = interpolateFlowText(
      step.args.text,
      task,
      await taskBaseUrl(run, step.args.text),
      run.record,
    )
    await withPrivilegedDb(run.orgId, "routine-flow-notify", (tx) =>
      tx.queueEvent({
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: crypto.randomUUID(),
        data: {
          summary,
          urgency: step.args.urgency ?? 50,
          targetUserIds: targets,
          ...(task && run.record
            ? { link: { tabType: run.record.decl.tabType, entityId: task.id } }
            : {}),
        },
        actorId: run.routine.ownerUserId,
        actorType: "system",
        agentId: run.routine.ownerAgentId ?? null,
        orgId: run.orgId,
        timestamp: new Date().toISOString(),
      }),
    )
    setState(
      state,
      "done",
      `Notified ${targets.length} ${targets.length === 1 ? "person" : "people"}.`,
      {
        targetUserIds: targets,
      },
    )
    return { kind: "next" }
  }

  let toolName: string
  let params: Record<string, unknown>
  let done: string
  let output: Record<string, unknown> = {}
  if (step.action === "message") {
    const to = resolvePerson(step.args.to, run, task)
    if (!to) return fail("Nobody to message: the task has no assignee.")
    toolName = "kernel:threads_create"
    params = {
      participantIds: [to],
      initialMessage: interpolateFlowText(
        step.args.text,
        task,
        await taskBaseUrl(run, step.args.text),
        run.record,
      ),
    }
    done = "Message sent."
    output = { to }
  } else if (step.action === "assign") {
    const to =
      typeof step.args.to === "object"
        ? await leastLoaded(run, record!, task!.projectId, step.args.to.leastLoaded)
        : resolvePerson(step.args.to, run, task)
    if (!to) return fail("Nobody to assign: the task has no assignee.")
    toolName = flowRecordTool(record!, "update")
    params = { [record!.decl.recordParam]: task!.id, assigneeId: to }
    done = "Assigned."
    output = { assigneeId: to }
  } else if (step.action === "set_field") {
    toolName = flowRecordTool(record!, "update")
    params = { [record!.decl.recordParam]: task!.id, fields: { [step.args.key]: step.args.value } }
    done = `Set ${step.args.key}.`
  } else if (step.action === "set_status") {
    toolName = flowRecordTool(record!, "update")
    params = { [record!.decl.recordParam]: task!.id, statusId: step.args.statusId }
    done = "Status set."
    output = { statusId: step.args.statusId }
  } else {
    toolName = flowRecordTool(record!, "comment")
    params = {
      [record!.decl.recordParam]: task!.id,
      body: interpolateFlowText(
        step.args.text,
        task,
        await taskBaseUrl(run, step.args.text),
        run.record,
      ),
    }
    done = "Comment posted."
  }
  const res = await callTool(run, toolName, params)
  if ("error" in res) return fail(res.error)
  if ("blocked" in res) {
    setState(state, "awaiting_approval", "Waiting for an approval.", {
      ...output,
      approvalId: res.blocked.approvalRequestId,
      tool: toolName,
    })
    return { kind: "park", status: "waiting_approval" }
  }
  setState(state, "done", done, output)
  return { kind: "next" }
}

// ── Waits ───────────────────────────────────────────────────────────────────

type WaitStep = Extract<RoutineFlowStep, { type: "wait" }>

/** The resume job's id: one wait per routine, record and step, so a newer run replaces it. */
export function flowWaitJobId(routineId: string, entityId: string | null, stepId: string): string {
  return `flowwait:${routineId}:${entityId ?? "none"}:${stepId}`
}

async function armWait(
  run: FlowRun,
  step: WaitStep,
  state: RoutineRunStepState,
): Promise<StepOutcome> {
  const cal = await loadOrgWorkingCalendar(run.orgId, run.flow.calendar ?? null)
  const now = run.deps.now?.() ?? new Date()
  const deadline = addWorkingTime(now, step.for.amount, step.for.unit, cal)
  setState(state, "waiting", `Waits until ${deadline.toISOString()}.`, {
    deadline: deadline.toISOString(),
    hop: run.hop,
  })
  const payload: FlowResumePayload = {
    orgId: run.orgId,
    routineId: run.routine.id,
    runId: run.runId,
    stepId: step.id,
  }
  const delayMs = Math.max(0, deadline.getTime() - now.getTime())
  const jobId = flowWaitJobId(run.routine.id, run.entityId, step.id)
  const enqueue = run.deps.enqueueResume ?? defaultEnqueueResume
  await enqueue(payload, { delayMs, jobId })
  return { kind: "park", status: "waiting" }
}

async function defaultEnqueueResume(
  payload: FlowResumePayload,
  opts: { delayMs: number; jobId: string },
): Promise<void> {
  const { enqueueAppJob } = await import("~/infra/jobs/jobs")
  await enqueueAppJob("kernel", FLOW_RESUME_JOB, payload, {
    delay: opts.delayMs,
    jobId: opts.jobId,
    replaceDelayed: true,
  })
}

/** A newer run for the same record takes over: older waiting runs end, "superseded". */
async function supersedeWaitingRuns(
  orgId: string,
  routineId: string,
  entityId: string,
): Promise<void> {
  const waiting = await withPrivilegedDb(orgId, "routine-flow-supersede", (tx) =>
    tx
      .select({ id: routineRuns.id, steps: routineRuns.steps, startedAt: routineRuns.startedAt })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.orgId, orgId),
          eq(routineRuns.routineId, routineId),
          eq(routineRuns.eventEntityId, entityId),
          eq(routineRuns.status, "waiting"),
        ),
      ),
  )
  for (const w of waiting) {
    const steps = (w.steps ?? []).map((s) =>
      s.state === "waiting"
        ? {
            ...s,
            state: "skipped" as const,
            endedAt: new Date().toISOString(),
            note: "Superseded by a newer run for the same record.",
          }
        : s,
    )
    await withPrivilegedDb(orgId, "routine-flow-superseded", (tx) =>
      tx
        .update(routineRuns)
        .set({
          status: "skipped_condition",
          steps,
          ranAt: new Date(),
          error: "Superseded by a newer run for the same record.",
          durationMs: w.startedAt ? Date.now() - w.startedAt.getTime() : null,
        })
        .where(and(eq(routineRuns.id, w.id), eq(routineRuns.status, "waiting"))),
    )
  }
}

/**
 * A wait's deadline came (the `routine-flow-resume` job): when the run still waits on that step,
 * its `until` is checked on the task as it is now; holding, the run goes on with the next step,
 * else it ends `skipped_condition`. A job that fires early (clock drift) re-arms for the rest.
 */
export async function resumeFlowWait(
  payload: FlowResumePayload,
  deps: FlowDeps = {},
): Promise<RoutineTickResult> {
  const { orgId, routineId, runId, stepId } = payload
  const loaded = await loadWaitingRun(orgId, routineId, runId)
  if (!loaded) return { status: "no_run" }
  const { routine, runRow } = loaded
  const steps = runRow.steps ?? []
  // The step's state by its id (never by position: the flow may have been edited meanwhile).
  const index = steps.findIndex((s) => s.id === stepId)
  const state = steps[index]
  if (state?.type !== "wait" || state.state !== "waiting") {
    return { status: "no_run", runId }
  }
  const deadline = new Date(String(state.output?.deadline ?? ""))
  const now = deps.now?.() ?? new Date()
  if (Number.isFinite(deadline.getTime()) && deadline.getTime() > now.getTime() + 1000) {
    // Fired early: re-armed under its own id. The job running now holds the wait's id, and a
    // queue ignores an add whose id belongs to an active job, so reusing it would drop the arm.
    const enqueue = deps.enqueueResume ?? defaultEnqueueResume
    const rearms = (payload.rearms ?? 0) + 1
    await enqueue(
      { orgId, routineId, runId, stepId, rearms },
      {
        delayMs: deadline.getTime() - now.getTime(),
        jobId: flowWaitRearmJobId(runId, stepId, rearms),
      },
    )
    return { status: "waiting", runId }
  }
  // Claim the run: only one resume goes on with it.
  if (!(await claimRun(orgId, runId, "waiting"))) return { status: "no_run", runId }
  const bare = claimedRun(orgId, routine, runRow, steps, deps)
  try {
    const ready = await resumeChecks(bare, index + 1)
    if ("refused" in ready) return ready.refused
    const run = await buildRun({
      orgId,
      routine,
      flow: routine.flow ?? bare.flow,
      runId: bare.runId,
      steps,
      startedAt: bare.startedAt,
      triggerAt: bare.triggerAt,
      entityId: bare.entityId,
      record: bare.record,
      outputThreadId: ready.outputThreadId,
      hop: bare.hop,
      triggerEvent: bare.triggerEvent,
      deps,
      runScopes: ready.runScopes,
    })
    const step = run.flow.steps[index]
    if (step?.type !== "wait" || step.id !== stepId) {
      throw new Error(`the flow has no wait step ${stepId} at position ${index + 1}`)
    }
    const task = await readTriggerTask(run)
    if (!evaluateCondition(step.until, task, run.triggerAt)) {
      setState(state, "skipped", "Its condition no longer held at the deadline.")
      for (const later of steps.slice(index + 1)) {
        if (later.state === "pending")
          setState(later, "skipped", "The flow ended at an earlier wait.")
      }
      await saveSteps(run)
      return await endFlowRun(run, "skipped_condition", null)
    }
    setState(state, "done", "Its condition still held at the deadline.")
    await saveSteps(run)
    return await continueFlow(run, index + 1)
  } catch (err) {
    return failRun(bare, err)
  }
}

/** An early-fired wait's nth re-arm: its own job id each time (`resumeFlowWait`). */
export function flowWaitRearmJobId(runId: string, stepId: string, n: number): string {
  return `flowwait-rearm:${runId}:${stepId}:${n}`
}

/** Takes a parked run (`from` → `running`); false when another resume or the sweep took it. */
async function claimRun(
  orgId: string,
  runId: string,
  from: "waiting" | "waiting_approval",
): Promise<boolean> {
  const claimed = await withPrivilegedDb(orgId, "routine-flow-claim", (tx) =>
    tx
      .update(routineRuns)
      // `ran_at` marks the run's progress while it runs: the sweep ends one that stopped moving.
      .set({ status: "running", ranAt: new Date() })
      .where(and(eq(routineRuns.id, runId), eq(routineRuns.status, from)))
      .returning({ id: routineRuns.id }),
  )
  return claimed.length > 0
}

/** A claimed run as its row stored it, before any check: enough to end it. */
function claimedRun(
  orgId: string,
  routine: RoutineRow,
  runRow: typeof routineRuns.$inferSelect,
  steps: RoutineRunStepState[],
  deps: FlowDeps,
): ClaimedRun {
  const context: RoutineRunFlowContext | null = runRow.flowContext ?? null
  return {
    orgId,
    routine,
    flow: routine.flow ?? { version: 1 as const, steps: [] },
    runId: runRow.id,
    steps,
    startedAt: runRow.startedAt?.getTime() ?? Date.now(),
    triggerAt: runRow.startedAt ?? new Date(),
    entityId: runRow.eventEntityId,
    record: flowRecordSourceOfLabel(orgId, runRow.triggerLabel),
    outputThreadId: routine.outputThreadId ?? "",
    hop: context?.hop ?? 0,
    triggerEvent: (context?.triggerEvent ?? undefined) as RoutineTriggerEvent | undefined,
    deps,
    // No scope resolved and no tool call possible: enough to end the run.
    actor: {
      actorType: "user",
      userId: routine.ownerUserId,
      orgId,
      scopes: [],
      dimensionGrants: {},
    },
    agentId: null,
    agentCeiling: null,
    context,
  }
}

type ClaimedRun = FlowRun & { context: RoutineRunFlowContext | null }

/** Ends a claimed run before it went on: its parked step skipped with the reason. */
async function endParked(
  bare: ClaimedRun,
  status: RoutineRunStatus,
  reason: string,
): Promise<RoutineTickResult> {
  for (const s of bare.steps) {
    if (s.state === "waiting" || s.state === "awaiting_approval") setState(s, "skipped", reason)
  }
  return endFlowRun(bare, status, reason, { touchRoutine: false })
}

/**
 * A claimed run that resumes (a wait came due, an approval was decided) goes on only when a
 * fresh tick would run: the flow is the one it started with (an edited flow ends it
 * `skipped_condition`, "flow changed"), and the tick's pre-run checks pass again
 * (`routineResumeGate`: switched on and active, owner active and holding its scopes, the owner
 * agent's ceiling, and the credit gate when an agent step comes before the next wait). A refused check ends
 * the run with its skipped status. `fromIndex`: the first step the resume may run.
 */
async function resumeChecks(
  bare: ClaimedRun,
  fromIndex: number,
): Promise<{ refused: RoutineTickResult } | { runScopes: string[]; outputThreadId: string }> {
  const { orgId, routine, context } = bare
  if (!routine.flow || !context || context.flowHash !== flowHash(routine.flow)) {
    const refused = await endParked(
      bare,
      "skipped_condition",
      "Flow changed: the routine's flow was edited while this run waited, so it did not go on.",
    )
    return { refused }
  }
  const { routineResumeGate, routineRunScopes, ensureOutputThread, flowLegNeedsCredits } =
    await import("./routine-worker")
  const needsCredits = flowLegNeedsCredits(routine.flow.steps, fromIndex)
  const gate = await routineResumeGate(orgId, routine, bare.deps, needsCredits)
  if (!gate.ok) {
    const refused = await endParked(bare, gate.status, gate.reason)
    return { refused }
  }
  const { threadId } = await ensureOutputThread(orgId, routine)
  return {
    runScopes: routineRunScopes(routine.scopes ?? [], gate.ownerScopes),
    outputThreadId: threadId,
  }
}

async function loadWaitingRun(orgId: string, routineId: string, runId: string) {
  return withPrivilegedDb(orgId, "routine-flow-load", async (tx) => {
    const [routine] = await tx
      .select()
      .from(routines)
      .where(and(eq(routines.id, routineId), eq(routines.orgId, orgId)))
      .limit(1)
    const [runRow] = await tx
      .select()
      .from(routineRuns)
      .where(and(eq(routineRuns.id, runId), eq(routineRuns.orgId, orgId)))
      .limit(1)
    if (!routine || !runRow || runRow.status !== "waiting") return null
    return { routine, runRow }
  })
}

// ── Agent steps ─────────────────────────────────────────────────────────────

type AgentStep = Extract<RoutineFlowStep, { type: "agent" }>

async function runAgentStep(
  run: FlowRun,
  step: AgentStep,
  state: RoutineRunStepState,
): Promise<StepOutcome> {
  const invoker = run.deps.agentInvoker
  if (!invoker) {
    setState(state, "failed", "No agent is available to run this step.")
    return { kind: "end", status: "failed", error: `Step ${step.id}: no agent invoker` }
  }
  // The step's start on the database's clock: its outcomes compare it with rows' `created_at`,
  // and the host's clock may run a few ms ahead of it.
  const { dbClockMs } = await import("./routine-run-resume")
  const stepStartedAt = new Date(await dbClockMs(run.orgId))
  const outcomes = step.outcomes ?? []
  const maxBumps = step.maxBumps ?? DEFAULT_MAX_BUMPS
  let bumps = 0
  const missingNow = async () => missingOutcomes(run, outcomes, stepStartedAt)
  const names = await outcomePeopleNames(run.orgId, outcomes)
  const describe = (o: RoutineFlowOutcome) => describeOutcome(o, names)
  const result = await inRunFrame(run, () =>
    invoker({
      orgId: run.orgId,
      ownerUserId: run.routine.ownerUserId,
      threadId: run.outputThreadId,
      prompt: step.prompt,
      scopes: run.actor.scopes,
      triggerEvent: run.triggerEvent,
      ...(outcomes.length > 0
        ? {
            // The bump (spec S10): after each turn, the outcomes still missing are named back to
            // the agent, at most `maxBumps` times (kernel-jobs.ts runs the steer as a re-prompt).
            nextSteer: async () => {
              if (bumps >= maxBumps) return null
              const missing = await missingNow()
              if (missing.length === 0) return null
              bumps++
              return `Before finishing you still need to: ${missing.map(describe).join("; ")}.`
            },
          }
        : {}),
    }),
  )
  if (result.failure) {
    setState(state, "failed", result.failure)
    return { kind: "end", status: "failed", error: `Step ${step.id}: ${result.failure}` }
  }
  const missing = outcomes.length > 0 ? await missingNow() : []
  if (missing.length > 0) {
    const note = `Still missing after ${bumps} ${bumps === 1 ? "reminder" : "reminders"}: ${missing
      .map(describe)
      .join("; ")}.`
    setState(state, "flagged", note, { bumps, missing })
    await notifyFlagged(run, step, note)
    return { kind: "next" }
  }
  setState(
    state,
    "done",
    bumps > 0 ? `Done after ${bumps} ${bumps === 1 ? "reminder" : "reminders"}.` : "Done.",
    {
      bumps,
      turnsAdded: result.turnsAdded,
    },
  )
  return { kind: "next" }
}

/**
 * The bump loop an agent invoker runs after a flow agent step's turn (kernel-jobs.ts): ask for the
 * steer, re-prompt the tick with it, until none is left or a re-prompt cannot be posted. Returns
 * how many re-prompts ran. `nextSteer` itself caps them at the step's `maxBumps`.
 */
export async function driveFlowBumps(
  nextSteer: (() => Promise<string | null>) | undefined,
  reprompt: (steer: string) => Promise<boolean>,
): Promise<number> {
  if (!nextSteer) return 0
  let n = 0
  for (let i = 0; i < 10; i++) {
    const steer = await nextSteer()
    if (!steer) break
    if (!(await reprompt(steer))) break
    n++
  }
  return n
}

/**
 * Pure: one outcome, as the bump and the flag name it. A person is named by `names` (their id to
 * their display name, `outcomePeopleNames`), never by their id.
 */
export function describeOutcome(
  o: RoutineFlowOutcome,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  if (o.kind === "message_posted") {
    if (o.to === "{{task.assigneeId}}") return "send the task's assignee a message"
    if (o.to === "{{owner}}") return "send the routine's owner a message"
    const name = names.get(o.to.toLowerCase())
    return name ? `send ${name} a message` : "send the chosen person a message"
  }
  if (o.kind === "field_set") return `set the task field "${o.field}"`
  if (o.kind === "status_is") return `move the task to status ${o.status}`
  return `call the tool ${o.tool}`
}

/** The display names of the people `outcomes` name by id (a message outcome's `to`). */
async function outcomePeopleNames(
  orgId: string,
  outcomes: readonly RoutineFlowOutcome[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      outcomes
        .map((o) => (o.kind === "message_posted" ? o.to.toLowerCase() : ""))
        .filter((id) => /^[0-9a-f-]{36}$/.test(id)),
    ),
  ]
  if (ids.length === 0) return new Map()
  const { users } = await import("~/db/schema/kernel")
  const rows = await withPrivilegedDb(orgId, "routine-flow-outcome-names", (tx) =>
    tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.orgId, orgId), inArray(users.id, ids))),
  )
  return new Map(rows.map((r) => [r.id.toLowerCase(), r.name]))
}

/** The outcomes not met yet: read from the record now and from this step's own writes. */
async function missingOutcomes(
  run: FlowRun,
  outcomes: RoutineFlowOutcome[],
  since: Date,
): Promise<RoutineFlowOutcome[]> {
  if (outcomes.length === 0) return []
  const task = outcomes.some((o) => o.kind === "field_set" || o.kind === "status_is")
    ? await readTriggerTask(run)
    : null
  const needTask = outcomes.some((o) => o.kind === "message_posted")
  const msgTask = needTask ? (task ?? (await readTriggerTask(run))) : null
  const missing: RoutineFlowOutcome[] = []
  for (const o of outcomes) {
    let met = false
    if (o.kind === "field_set") met = !!task && !isEmptyCell(task.fields[o.field])
    else if (o.kind === "status_is") met = !!task && task.statusId === o.status
    else if (o.kind === "tool_called") met = await toolCalledSince(run, o.tool, since)
    else met = await messagePostedSince(run, resolvePerson(o.to, run, msgTask), since)
    if (!met) missing.push(o)
  }
  return missing
}

/** The names a tool goes by in a turn's `toolCalls` (app:name or app__name). */
function toolNames(tool: string): string[] {
  return [...new Set([tool, tool.replace(":", "__"), tool.replace("__", ":")])]
}

/**
 * Did THIS run's agent call `tool` since the step began? Read from the replies its turns wrote in
 * the output thread, each stamped with the run's id (`metadata.routineRunId`): another run of the
 * routine, in the same thread at the same time, never counts. A tool reached through
 * `kernel__call_tool` counts by its inner name.
 */
async function toolCalledSince(run: FlowRun, tool: string, since: Date): Promise<boolean> {
  const { sql: drizzleSql } = await import("drizzle-orm")
  const { schemaRef } = await import("~/db/schema-ref")
  const names = drizzleSql.join(
    toolNames(tool).map((n) => drizzleSql`${n}`),
    drizzleSql`, `,
  )
  const rows = await withPrivilegedDb(run.orgId, "routine-flow-tool-called", async (tx) =>
    extractRows<{ n: number }>(
      await tx.execute(drizzleSql`
        SELECT count(*)::int AS n FROM ${drizzleSql.raw(schemaRef("kernel"))}.messages m,
               jsonb_array_elements(
                 CASE WHEN jsonb_typeof(m.metadata->'toolCalls') = 'array'
                      THEN m.metadata->'toolCalls' ELSE '[]'::jsonb END
               ) AS c
         WHERE m.org_id = ${run.orgId}::uuid AND m.thread_id = ${run.outputThreadId}::uuid
           AND m.metadata->>'routineRunId' = ${run.runId}
           AND m.created_at >= ${since.toISOString()}::timestamptz
           AND (
             c->>'toolName' IN (${names})
             OR (c->>'toolName' IN ('kernel__call_tool', 'kernel:call_tool')
                 AND c->'args'->>'name' IN (${names}))
           )
           AND COALESCE(c->>'status', '') <> 'error' AND c->'error' IS NULL`),
    ),
  )
  return (rows[0]?.n ?? 0) > 0
}

/**
 * Did THIS run post a message since the step began to `to`: a thread id, or a person? Its
 * messages carry the run's id (`metadata.routineRunId`) and are written by the routine's agent
 * identity, never the owner's own. A person means a conversation they take part in, other than
 * the routine's output thread; the routine's owner means a conversation with the owner alone
 * (the direct message a flow's `message` step to `{{owner}}` opens).
 */
async function messagePostedSince(run: FlowRun, to: string | null, since: Date): Promise<boolean> {
  if (!to) return false
  const { sql: drizzleSql } = await import("drizzle-orm")
  const { schemaRef } = await import("~/db/schema-ref")
  const K = drizzleSql.raw(schemaRef("kernel"))
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(to)
  if (!isUuid) return false
  const toOwner = to === run.routine.ownerUserId
  const rows = await withPrivilegedDb(run.orgId, "routine-flow-message-posted", async (tx) =>
    extractRows<{ n: number }>(
      await tx.execute(drizzleSql`
        SELECT count(*)::int AS n FROM ${K}.messages m
         WHERE m.org_id = ${run.orgId}::uuid
           AND m.created_at >= ${since.toISOString()}::timestamptz
           AND m.thread_id <> ${run.outputThreadId}::uuid
           AND m.author_type = 'agent'
           AND m.metadata->>'routineRunId' = ${run.runId}
           AND (
             m.thread_id = ${to}::uuid
             OR (${toOwner} AND NOT EXISTS (
               SELECT 1 FROM ${K}.thread_participants p
                WHERE p.thread_id = m.thread_id AND p.user_id <> ${to}::uuid
             ))
             OR (NOT ${toOwner} AND EXISTS (
               SELECT 1 FROM ${K}.thread_participants p
                WHERE p.thread_id = m.thread_id AND p.user_id = ${to}::uuid
             ))
           )`),
    ),
  )
  return (rows[0]?.n ?? 0) > 0
}

/** The owner hears of a flagged step on Home (attention pipeline), naming what is missing. */
async function notifyFlagged(run: FlowRun, step: AgentStep, note: string): Promise<void> {
  try {
    await withPrivilegedDb(run.orgId, "routine-flow-flagged", (tx) =>
      tx.queueEvent({
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: crypto.randomUUID(),
        data: {
          summary: `Routine "${routineDisplayName(run.routine)}", step ${step.id}: ${note}`,
          urgency: 60,
          targetUserIds: [run.routine.ownerUserId],
          link:
            run.entityId && run.record
              ? { tabType: run.record.decl.tabType, entityId: run.entityId }
              : { tabType: "thread", entityId: run.outputThreadId },
          routineFlag: { routineId: run.routine.id, runId: run.runId, stepId: step.id },
        },
        actorId: run.routine.ownerUserId,
        actorType: "system",
        agentId: run.routine.ownerAgentId ?? null,
        orgId: run.orgId,
        timestamp: new Date().toISOString(),
      }),
    )
  } catch (err) {
    log.error({ err, routineId: run.routine.id, runId: run.runId }, "flow: flagged alert failed")
  }
}

// ── Persistence and the end ─────────────────────────────────────────────────

async function saveSteps(run: FlowRun): Promise<void> {
  await withPrivilegedDb(run.orgId, "routine-flow-steps", (tx) =>
    tx
      .update(routineRuns)
      .set({ steps: run.steps, ranAt: new Date() })
      .where(eq(routineRuns.id, run.runId)),
  )
}

async function setRunStatus(run: FlowRun, status: RoutineRunStatus): Promise<void> {
  await withPrivilegedDb(run.orgId, "routine-flow-status", (tx) =>
    tx.update(routineRuns).set({ status }).where(eq(routineRuns.id, run.runId)),
  )
}

async function clearInFlight(run: FlowRun): Promise<void> {
  const eventId = run.triggerEvent?.eventId
  if (!eventId) return
  const { inFlightKey } = await import("./routine-event-reconciler")
  const { redis } = await import("~/lib/redis")
  await redis.del(inFlightKey(run.routine.id, eventId)).catch(() => undefined)
}

/** The end of a flow run: its row, the routine's last run, the live event, the owner's alert. */
async function endFlowRun(
  run: FlowRun,
  status: RoutineRunStatus,
  error: string | null,
  /** false: a pre-run check refused the run, and already wrote the routine's state. */
  opts: { touchRoutine?: boolean } = {},
): Promise<RoutineTickResult> {
  const durationMs = Date.now() - run.startedAt
  for (const s of run.steps) {
    if (s.state === "pending" && status !== "succeeded" && status !== "flagged") {
      setState(s, "skipped", "The flow ended before this step.")
    }
  }
  await withPrivilegedDb(run.orgId, "routine-flow-end", (tx) =>
    tx
      .update(routineRuns)
      .set({ status, steps: run.steps, ranAt: new Date(), durationMs, error })
      .where(
        and(
          eq(routineRuns.id, run.runId),
          inArray(routineRuns.status, ["running", "waiting", "waiting_approval"]),
        ),
      ),
  )
  await clearInFlight(run)
  const failed = status === "failed"
  if (opts.touchRoutine !== false)
    await withPrivilegedDb(run.orgId, "routine-flow-last-run", (tx) =>
      tx
        .update(routines)
        .set({
          lastRunAt: new Date(),
          lastRunStatus: failed ? "failed" : "succeeded",
          lastRunError: failed ? error : null,
          ...(run.routine.kind === "scheduled" && !failed ? { status: "completed" as const } : {}),
          updatedAt: new Date(),
        })
        .where(eq(routines.id, run.routine.id)),
    )
  const { emitRoutineEvent } = await import("./routine-worker")
  const ranAt = new Date().toISOString()
  await emitRoutineEvent(
    run.orgId,
    run.routine.ownerUserId,
    run.routine.ownerAgentId,
    run.routine.id,
    "run_completed",
    {
      run: {
        id: run.runId,
        routineId: run.routine.id,
        ranAt,
        status,
        durationMs,
        errorMessage: error,
        eventEntityId: run.entityId,
      },
      runId: run.runId,
      status,
      routineName: run.routine.name,
      eventEntityId: run.entityId,
      durationMs,
      ranAt,
      error,
    },
  )
  if (failed) {
    try {
      const { queueRoutineAlert } = await import("./routine-alert")
      await withPrivilegedDb(run.orgId, "routine-flow-failed-notify-owner", (tx) =>
        queueRoutineAlert(tx, {
          orgId: run.orgId,
          routine: { ...run.routine, outputThreadId: run.outputThreadId },
          status: "failed",
          error,
        }),
      )
    } catch (err) {
      log.error({ err, routineId: run.routine.id }, "flow: failed-run alert not queued")
    }
  }
  return { status, runId: run.runId, durationMs }
}

// ── Approvals ───────────────────────────────────────────────────────────────

const UNDECIDED_APPROVAL = new Set(["pending", "deferred", "approving"])

/**
 * An approval a flow run's action parked on was decided (routine-run-resume.ts hands every
 * routine decision here first). Approved: the step is done (the approved call ran) and the flow
 * goes on; refused or lapsed: the step and the run fail. Null when the approval is not a flow
 * run's, so the legacy resume handles it.
 */
export async function resumeFlowOnDecision(
  orgId: string,
  approvalId: string,
  /** The seams, or how to get them for the run's routine (the production tick's, per routine). */
  depsOf: FlowDeps | ((routineId: string) => Promise<FlowDeps>) = {},
): Promise<RoutineTickResult | null> {
  await ensureOrgApps(orgId)
  const { sql: drizzleSql } = await import("drizzle-orm")
  const { schemaRef } = await import("~/db/schema-ref")
  const K = drizzleSql.raw(schemaRef("kernel"))
  const [hit] = await withPrivilegedDb(orgId, "routine-flow-approval", async (tx) =>
    extractRows<{ run_id: string; routine_id: string; approval_status: string }>(
      await tx.execute(drizzleSql`
        SELECT r.id::text AS run_id, r.routine_id::text AS routine_id, a.status AS approval_status
          FROM ${K}.approval_requests a
          JOIN ${K}.routine_runs r
            ON r.org_id = a.org_id AND r.id::text = a.metadata->>'originRoutineRunId'
         WHERE a.id = ${approvalId}::uuid AND a.org_id = ${orgId}::uuid
           AND r.steps IS NOT NULL
         LIMIT 1`),
    ),
  )
  if (!hit) return null
  if (UNDECIDED_APPROVAL.has(hit.approval_status)) return { status: "no_run", runId: hit.run_id }
  if (!(await claimRun(orgId, hit.run_id, "waiting_approval"))) {
    return { status: "no_run", runId: hit.run_id }
  }
  const loaded = await withPrivilegedDb(orgId, "routine-flow-approval-load", async (tx) => {
    const [routine] = await tx
      .select()
      .from(routines)
      .where(eq(routines.id, hit.routine_id))
      .limit(1)
    const [runRow] = await tx
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.id, hit.run_id))
      .limit(1)
    return routine && runRow ? { routine, runRow } : null
  })
  if (!loaded) return { status: "no_run", runId: hit.run_id }
  const { routine, runRow } = loaded
  const steps = runRow.steps ?? []
  const index = steps.findIndex(
    (s) => s.state === "awaiting_approval" && s.output?.approvalId === approvalId,
  )
  const deps = typeof depsOf === "function" ? await depsOf(routine.id) : depsOf
  const bare = claimedRun(orgId, routine, runRow, steps, deps)
  try {
    const ready = await resumeChecks(bare, index + 1)
    if ("refused" in ready) return ready.refused
    const run = await buildRun({
      orgId,
      routine,
      flow: routine.flow ?? bare.flow,
      runId: bare.runId,
      steps,
      startedAt: bare.startedAt,
      triggerAt: bare.triggerAt,
      entityId: bare.entityId,
      record: bare.record,
      outputThreadId: ready.outputThreadId,
      hop: bare.hop,
      triggerEvent: bare.triggerEvent,
      deps,
      runScopes: ready.runScopes,
    })
    if (index < 0) throw new Error(`no step of the run waits on approval ${approvalId}`)
    const state = steps[index]!
    if (hit.approval_status !== "approved") {
      setState(state, "failed", `The approval was ${hit.approval_status}.`)
      await saveSteps(run)
      return await endFlowRun(
        run,
        "failed",
        `Step ${state.id}: the approval was ${hit.approval_status}`,
      )
    }
    setState(state, "done", "Approved and done.")
    await saveSteps(run)
    return await continueFlow(run, index + 1)
  } catch (err) {
    return failRun(bare, err)
  }
}

/**
 * The `kernel:routine-flow-resume` job: takes the routine+record lock a flow's event tick takes,
 * then `resumeFlowWait`. A busy lock brings the job back in a minute (an hour at most).
 */
export async function runFlowResumeJob(
  payload: Partial<FlowResumePayload>,
  deps: FlowDeps = {},
): Promise<RoutineTickResult> {
  const { orgId, routineId, runId, stepId, rearms } = payload
  if (!orgId || !routineId || !runId || !stepId) {
    log.warn({ payload }, "routine-flow-resume: missing ids")
    return { status: "no_run" }
  }
  await ensureOrgApps(orgId)
  const [run] = await withPrivilegedDb(orgId, "routine-flow-resume-entity", (tx) =>
    tx
      .select({ entityId: routineRuns.eventEntityId })
      .from(routineRuns)
      .where(and(eq(routineRuns.id, runId), eq(routineRuns.orgId, orgId)))
      .limit(1),
  )
  if (!run) return { status: "no_run" }
  const { redis } = await import("~/lib/redis")
  const { ROUTINE_LOCK_TTL_SECONDS, startRoutineLockHeartbeat } = await import("./routine-worker")
  const lockKey = `routine-lock:${routineId}${run.entityId ? `:${run.entityId}` : ""}`
  const token = crypto.randomUUID()
  const got = await redis.set(lockKey, token, "EX", ROUTINE_LOCK_TTL_SECONDS, "NX")
  if (got !== "OK") {
    const retries = (payload.lockRetries ?? 0) + 1
    if (retries > 60) {
      log.error(
        { routineId, runId },
        "routine-flow-resume: the record stayed busy; the wait is dropped",
      )
      return { status: "no_run", runId }
    }
    const enqueue = deps.enqueueResume ?? defaultEnqueueResume
    await enqueue(
      { orgId, routineId, runId, stepId, lockRetries: retries, ...(rearms ? { rearms } : {}) },
      { jobId: `flowwait-retry:${runId}:${stepId}:${retries}`, delayMs: 60_000 },
    )
    return { status: "lock_busy", runId }
  }
  // A long agent step after the wait keeps the record's lock, as a tick keeps it.
  const stopHeartbeat = startRoutineLockHeartbeat(routineId, lockKey)
  try {
    return await resumeFlowWait(
      { orgId, routineId, runId, stepId, ...(rearms ? { rearms } : {}) },
      deps,
    )
  } finally {
    stopHeartbeat()
    await redis
      .eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
        1,
        lockKey,
        token,
      )
      .catch(() => undefined)
  }
}

// ── The stuck-run sweep ─────────────────────────────────────────────────────

/** A flow run `running` with no step saved for this long stopped (its process died). */
export const FLOW_RUN_STALE_MS = 2 * 60 * 60 * 1000
/**
 * A wait this far past its deadline lost its resume job: the job comes back for at most an hour
 * while the record's lock is held (runFlowResumeJob), so this is well past any live resume.
 */
export const FLOW_WAIT_OVERDUE_MS = 2 * 60 * 60 * 1000

/**
 * Ends the org's flow runs nothing will carry on: `running` with no progress for
 * `FLOW_RUN_STALE_MS`, or `waiting` on a wait whose deadline passed `FLOW_WAIT_OVERDUE_MS` ago.
 * Each ends `failed`, its owner told as for any failed run, and no longer counts as served, so
 * the event reconciler fires the routine again for its event. Returns how many ended.
 */
export async function sweepStuckFlowRuns(orgId: string, now = new Date()): Promise<number> {
  await ensureOrgApps(orgId)
  const { sql: drizzleSql } = await import("drizzle-orm")
  const staleBefore = new Date(now.getTime() - FLOW_RUN_STALE_MS)
  const overdueBefore = new Date(now.getTime() - FLOW_WAIT_OVERDUE_MS)
  const candidates = await withPrivilegedDb(orgId, "routine-flow-sweep-find", (tx) =>
    tx
      .select({ id: routineRuns.id, status: routineRuns.status })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.orgId, orgId),
          drizzleSql`${routineRuns.steps} IS NOT NULL`,
          drizzleSql`(
            (${routineRuns.status} = 'running' AND ${routineRuns.ranAt} < ${staleBefore.toISOString()}::timestamptz)
            OR (${routineRuns.status} = 'waiting' AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(${routineRuns.steps}) e
               WHERE e->>'state' = 'waiting'
                 AND COALESCE(e->'output'->>'deadline', '') ~ '^[0-9]{4}-'
                 AND (e->'output'->>'deadline')::timestamptz < ${overdueBefore.toISOString()}::timestamptz
            ))
          )`,
        ),
      )
      .limit(500),
  )
  let ended = 0
  for (const c of candidates) {
    // Claimed as a resume claims it, so a resume racing the sweep and the sweep never both act.
    const claimed = await withPrivilegedDb(orgId, "routine-flow-sweep-claim", (tx) =>
      tx
        .update(routineRuns)
        .set({ status: "running", ranAt: now })
        .where(
          and(
            eq(routineRuns.id, c.id),
            c.status === "running"
              ? and(
                  eq(routineRuns.status, "running"),
                  drizzleSql`${routineRuns.ranAt} < ${staleBefore.toISOString()}::timestamptz`,
                )
              : eq(routineRuns.status, "waiting"),
          ),
        )
        .returning(),
    )
    const runRow = claimed[0]
    if (!runRow) continue
    const [routine] = await withPrivilegedDb(orgId, "routine-flow-sweep-routine", (tx) =>
      tx.select().from(routines).where(eq(routines.id, runRow.routineId)).limit(1),
    )
    if (!routine) continue
    const reason =
      c.status === "running"
        ? "The run stopped without finishing: it made no progress for two hours."
        : "The run's wait never resumed: its deadline passed two hours ago."
    const steps = runRow.steps ?? []
    for (const s of steps) {
      if (s.state === "running" || s.state === "waiting") setState(s, "failed", reason)
    }
    const ctx = runRow.flowContext ?? null
    await endFlowRun(
      bareRun({
        orgId,
        routine,
        flow: routine.flow ?? { version: 1, steps: [] },
        runId: runRow.id,
        steps,
        startedAt: runRow.startedAt?.getTime() ?? now.getTime(),
        triggerAt: runRow.startedAt ?? now,
        entityId: runRow.eventEntityId,
        record: flowRecordSourceOfLabel(orgId, runRow.triggerLabel),
        outputThreadId: routine.outputThreadId ?? "",
        hop: ctx?.hop ?? 0,
        triggerEvent: (ctx?.triggerEvent ?? undefined) as RoutineTriggerEvent | undefined,
        deps: {},
      }),
      "failed",
      reason,
    )
    log.warn({ orgId, routineId: routine.id, runId: runRow.id, was: c.status }, "flow run swept")
    ended++
  }
  return ended
}

/** Every org's stuck flow runs, for the scheduled sweep (kernel-jobs.ts). */
export async function sweepAllStuckFlowRuns(): Promise<number> {
  const { sql: drizzleSql } = await import("drizzle-orm")
  const { withSystemDb } = await import("~/db/privileged")
  // An org being moved keeps its runs as they are until the move ends.
  const { sweepSkippingMoving, writeUnlessMoving } = await import(
    "~/modules/org/transfer-state/skip-moving"
  )
  const orgs = await sweepSkippingMoving((notMoving) =>
    withSystemDb("routine-flow-sweep-orgs", (db) =>
      db
        .selectDistinct({ orgId: routineRuns.orgId })
        .from(routineRuns)
        .where(
          and(
            inArray(routineRuns.status, ["running", "waiting"]),
            drizzleSql`${routineRuns.steps} IS NOT NULL`,
            notMoving(routineRuns.orgId),
          ),
        ),
    ),
  )
  let ended = 0
  for (const { orgId } of orgs) {
    const n = await writeUnlessMoving(orgId, () => sweepStuckFlowRuns(orgId))
    if (typeof n === "number") ended += n
  }
  return ended
}
