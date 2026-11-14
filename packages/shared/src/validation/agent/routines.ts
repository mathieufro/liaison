// SPDX-License-Identifier: FSL-1.1-ALv2
import { CronExpressionParser } from "cron-parser"
import { z } from "zod"
import { reasoningLevelSchema } from "../../reasoning"

const NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

// Built once at module load — Intl.supportedValuesOf is available in modern
// runtimes (Node 18+, Bun, modern browsers).
const IANA_TIMEZONES = new Set<string>(
  typeof Intl !== "undefined" &&
    typeof (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf === "function"
    ? (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf(
        "timeZone",
      )
    : ["UTC"],
)

export const routineNameSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(NAME, "kebab-case required (lowercase alnum + hyphens)")

export const cronExpressionSchema = z
  .string()
  .refine(
    (s) => {
      try {
        CronExpressionParser.parse(s)
        return true
      } catch {
        return false
      }
    },
    { message: "Invalid cron expression" },
  )
  .refine((s) => s.trim().split(/\s+/).length === 5, {
    message: "Cron must be a 5-field expression (no seconds)",
  })

export const timezoneSchema = z
  .string()
  .refine((s) => IANA_TIMEZONES.has(s), { message: "Unknown IANA timezone" })

export const routineStatusSchema = z.enum([
  "active",
  "paused_scope_mismatch",
  "paused_no_credits",
  "paused_user",
  "completed",
])

export const routineKindSchema = z.enum(["recurring", "scheduled", "event"])
export const routineVisibilitySchema = z.enum(["personal", "shared"])

/**
 * Event-trigger string — three colon-separated `app:entity:action` segments so
 * the subscriber's `event.split(":")` always yields `[app, entity, action]`
 * (event-routine-subscriber.ts). Mirrors the DB `routines_kind_columns_chk`
 * `event IS NOT NULL` branch.
 */
const routineEventSchema = z.string().regex(/^[a-z][a-z0-9_-]*:[a-z_]+:[a-z_]+$/)

/**
 * Enforce the kind/column contract — mirrors the DB `routines_kind_columns_chk`
 * so the API returns a clean 400 instead of a raw DB error:
 *  - recurring ⇒ cron + timezone present, runAt + event absent.
 *  - scheduled ⇒ runAt present, cron + timezone + event absent.
 *  - event     ⇒ event present, cron + timezone + runAt absent.
 */
function kindColumnsValid(v: {
  kind: "recurring" | "scheduled" | "event"
  cron?: string | null
  timezone?: string | null
  runAt?: string | null
  event?: string | null
}): boolean {
  if (v.kind === "event") {
    return Boolean(v.event) && !v.cron && !v.timezone && !v.runAt
  }
  if (v.kind === "recurring") {
    return Boolean(v.cron) && Boolean(v.timezone) && !v.runAt && !v.event
  }
  return Boolean(v.runAt) && !v.cron && !v.timezone && !v.event
}

/**
 * Routine token budget and hard limit (S17). Both optional, null = none.
 * Bounded at 50M: a routine tick far past that is a runaway, not a job.
 */
export const ROUTINE_TOKEN_MAX = 50_000_000
export const routineTokenBudgetSchema = z
  .number()
  .int()
  .positive()
  .max(ROUTINE_TOKEN_MAX)
  .nullable()
  .optional()
  .describe(
    "A soft token budget for each run of this routine (input + output tokens). The runner tells the " +
      "agent in the run's prompt that it has about this many tokens for the job, so it plans to finish " +
      "within it. Omit/null for no budget.",
  )
export const routineHardTokenLimitSchema = z
  .number()
  .int()
  .positive()
  .max(ROUTINE_TOKEN_MAX)
  .nullable()
  .optional()
  .describe(
    "A hard token limit for each run of this routine: the run is stopped once its cumulative tokens " +
      "(input including cached, plus output, counting any agent it asks) reach it, and its output says " +
      "it stopped at the limit. Omit/null for no limit. Set it above tokenBudget.",
  )

/**
 * Where a routine runs (S21, D9): the cloud (default), the owner's node, or the
 * node when one is live and the cloud otherwise.
 */
export const ROUTINE_RUNS_ON = ["cloud", "node", "node_else_cloud"] as const
export type RoutineRunsOn = (typeof ROUTINE_RUNS_ON)[number]
export const routineRunsOnSchema = z
  .enum(ROUTINE_RUNS_ON)
  .optional()
  .describe(
    "Where each run happens: 'cloud' (default), 'node' (the owner's own computer running Liaison as " +
      "their node, with their own Claude sign-in and local tools; a run waits there while it is offline " +
      "and the owner is notified) or 'node_else_cloud' (the node when it is online, else the cloud). " +
      "Set 'node' only when the person asked for the routine to run on their computer. When it runs " +
      "on their computer, the result carries nodeGuardrails.riskNote: tell the person that note before " +
      "you confirm the routine is set up.",
  )

// ── Routine flows (0303) ──────────────────────────────────────────────────────
//
// A flow is a routine's ordered steps after its trigger: actions (run by the server, no agent),
// waits (in working time, durable) and agent steps (an agent turn with optional required
// outcomes). `routines.flow` null = a legacy routine: one agent step, its prompt, no outcomes.
// "If indents its branch" in the editor = consecutive steps sharing the same `if`; there are no
// nested step lists.

/** Most steps in one flow. */
export const ROUTINE_FLOW_MAX_STEPS = 20
/** Longest wait a flow step may hold, in days. */
export const ROUTINE_FLOW_MAX_WAIT_DAYS = 60

const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/
const flowStepIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "step id: a-z, 0-9, _ -")
/** A person: a user id, the routine's owner, or the trigger task's assignee. */
const flowPersonRefSchema = z.union([
  z.string().uuid(),
  z.literal("{{owner}}"),
  z.literal("{{task.assigneeId}}"),
])
const flowScalarSchema = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()])
const flowFieldRefSchema = z.union([
  z.literal("status"),
  z.literal("assignee"),
  z.string().regex(/^fields\.[a-z][a-z0-9_]{0,39}$/),
])

export type RoutineFlowCondition =
  | { all: RoutineFlowCondition[] }
  | { any: RoutineFlowCondition[] }
  | {
      field: string
      op: "eq" | "in" | "empty" | "not_empty"
      value?: string | number | boolean | null | Array<string | number>
    }
  | { op: "status_unchanged_since_trigger" }

const flowLeafConditionSchema = z
  .object({
    field: flowFieldRefSchema,
    op: z.enum(["eq", "in", "empty", "not_empty"]),
    value: z
      .union([
        flowScalarSchema,
        z.array(z.union([z.string().max(200), z.number().finite()])).max(50),
      ])
      .optional(),
  })
  .strict()
  .refine((c) => (c.op === "eq" ? c.value !== undefined && !Array.isArray(c.value) : true), {
    message: "op 'eq' needs a single value",
  })
  .refine((c) => (c.op === "in" ? Array.isArray(c.value) && c.value.length > 0 : true), {
    message: "op 'in' needs a non-empty list of values",
  })
  .refine((c) => (c.op === "empty" || c.op === "not_empty" ? c.value === undefined : true), {
    message: "ops 'empty' and 'not_empty' take no value",
  })

export const routineFlowConditionSchema: z.ZodType<RoutineFlowCondition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(routineFlowConditionSchema).min(1).max(10) }).strict(),
    z.object({ any: z.array(routineFlowConditionSchema).min(1).max(10) }).strict(),
    z.object({ op: z.literal("status_unchanged_since_trigger") }).strict(),
    flowLeafConditionSchema,
  ]),
)

function conditionDepth(c: RoutineFlowCondition): number {
  if ("all" in c) return 1 + Math.max(...c.all.map(conditionDepth))
  if ("any" in c) return 1 + Math.max(...c.any.map(conditionDepth))
  return 1
}

const boundedConditionSchema = routineFlowConditionSchema.refine((c) => conditionDepth(c) <= 3, {
  message: "conditions nest at most 3 levels deep",
})

const actionBase = {
  id: flowStepIdSchema,
  type: z.literal("action"),
  if: boundedConditionSchema.optional(),
}
const flowActionStepSchema = z.union([
  z
    .object({
      ...actionBase,
      action: z.literal("assign"),
      args: z
        .object({
          to: z.union([
            flowPersonRefSchema,
            z.object({ leastLoaded: z.array(z.string().uuid()).min(1).max(50) }).strict(),
          ]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      action: z.literal("set_field"),
      args: z
        .object({
          key: z.string().regex(FIELD_KEY),
          value: z.union([flowScalarSchema, z.array(z.string().max(200)).max(50)]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      action: z.literal("set_status"),
      args: z.object({ statusId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      action: z.literal("message"),
      args: z.object({ to: flowPersonRefSchema, text: z.string().min(1).max(4000) }).strict(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      action: z.literal("notify"),
      args: z
        .object({
          to: z.array(flowPersonRefSchema).min(1).max(20),
          text: z.string().min(1).max(500),
          urgency: z.number().int().min(0).max(100).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      action: z.literal("comment"),
      args: z.object({ text: z.string().min(1).max(4000) }).strict(),
    })
    .strict(),
])

const WAIT_UNIT_MAX = { working_hours: 60 * 9, working_days: 60, hours: 60 * 24, days: 60 } as const
const flowWaitStepSchema = z
  .object({
    id: flowStepIdSchema,
    type: z.literal("wait"),
    for: z
      .object({
        amount: z.number().int().positive(),
        unit: z.enum(["working_hours", "working_days", "hours", "days"]),
      })
      .strict()
      .refine((f) => f.amount <= WAIT_UNIT_MAX[f.unit], {
        message: `a wait holds at most ${ROUTINE_FLOW_MAX_WAIT_DAYS} days`,
      }),
    until: boundedConditionSchema,
    if: boundedConditionSchema.optional(),
  })
  .strict()

export const routineFlowOutcomeSchema = z.union([
  z
    .object({
      kind: z.literal("message_posted"),
      to: z.union([flowPersonRefSchema, z.string().uuid()]),
    })
    .strict(),
  z.object({ kind: z.literal("field_set"), field: z.string().regex(FIELD_KEY) }).strict(),
  z.object({ kind: z.literal("status_is"), status: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("tool_called"), tool: z.string().min(1).max(120) }).strict(),
])
export type RoutineFlowOutcome = z.infer<typeof routineFlowOutcomeSchema>

const flowAgentStepSchema = z
  .object({
    id: flowStepIdSchema,
    type: z.literal("agent"),
    prompt: z.string().min(1).max(20_000),
    outcomes: z.array(routineFlowOutcomeSchema).max(10).optional(),
    maxBumps: z.number().int().min(0).max(3).optional(),
    if: boundedConditionSchema.optional(),
  })
  .strict()

export const routineFlowStepSchema = z.union([
  flowActionStepSchema,
  flowWaitStepSchema,
  flowAgentStepSchema,
])
export type RoutineFlowStep = z.infer<typeof routineFlowStepSchema>

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
export const routineFlowCalendarSchema = z
  .object({
    timezone: timezoneSchema.optional(),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    start: z.string().regex(HHMM).optional(),
    end: z.string().regex(HHMM).optional(),
  })
  .strict()
  .refine((c) => !c.start || !c.end || c.start < c.end, { message: "start must be before end" })
export type RoutineFlowCalendar = z.infer<typeof routineFlowCalendarSchema>

export const routineFlowSchema = z
  .object({
    version: z.literal(1),
    steps: z.array(routineFlowStepSchema).min(1).max(ROUTINE_FLOW_MAX_STEPS),
    calendar: routineFlowCalendarSchema.optional(),
  })
  .strict()
  .refine((f) => new Set(f.steps.map((s) => s.id)).size === f.steps.length, {
    message: "step ids must be unique",
  })
  .describe(
    "The routine's steps, run in order after its trigger. Steps: " +
      "{id, type:'action', action:'assign'|'set_field'|'set_status'|'message'|'notify'|'comment', args, if?} " +
      "(run by the server as the owner, no agent); {id, type:'wait', for:{amount, unit:'working_hours'|" +
      "'working_days'|'hours'|'days'}, until: condition} (continue only if the condition still holds then); " +
      "{id, type:'agent', prompt, outcomes?, maxBumps?, if?} (an agent turn; each outcome is checked after it). " +
      "A condition reads the trigger task fresh: {field:'status'|'assignee'|'fields.<key>', op:'eq'|'in'|" +
      "'empty'|'not_empty', value?}, {op:'status_unchanged_since_trigger'}, {all:[...]} or {any:[...]}. " +
      "Text may use {{task.title}}, {{task.key}}, {{task.url}}, {{task.assigneeName}}, {{task.fields.<key>}}.",
  )
export type RoutineFlow = z.infer<typeof routineFlowSchema>

/** The task events a projects event filter (projectId, from/to status, fields) applies to. */
export const PROJECT_TASK_FILTER_EVENTS = [
  "projects:task:status_changed",
  "projects:task:updated",
  "projects:task:created",
] as const

/**
 * Sender filter of a `mail:message:create` event routine (S26): the routine
 * fires only for inbound mail from one of these contacts, or from a member of
 * one of these contact groups. Checked before the agent runs, as the routine
 * owner, so non-matching mail costs no tokens.
 */
export const routineEventFilterSchema = z
  .object({
    fromContactIds: z.array(z.string().uuid()).max(200).optional(),
    fromGroupIds: z.array(z.string().uuid()).max(50).optional(),
    tableId: z.string().uuid().optional(),
    column: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .optional(),
    to: z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]).optional(),
    // Projects task events (0303): one project, a status change from/to, field values.
    projectId: z.string().uuid().optional(),
    fromStatusId: z.string().uuid().nullable().optional(),
    toStatusId: z.string().uuid().optional(),
    fields: z
      .record(
        z.string().regex(FIELD_KEY),
        z.union([flowScalarSchema, z.array(flowScalarSchema).min(1).max(50)]),
      )
      .refine((f) => Object.keys(f).length <= 20, { message: "at most 20 fields" })
      .optional(),
  })
  .strict()
  .nullable()
  .optional()
  .describe(
    "For event 'mail:message:create': fire only on inbound mail whose sender is one of " +
      "fromContactIds (contact ids) or a member of one of fromGroupIds (contact group ids). Non-matching " +
      "mail never starts the routine. For 'kernel:dashboard_table_row:created|updated|deleted': " +
      "{tableId} fires only for rows of that table, {column} only when that column changed, " +
      "{to} only when the column changed TO that value (a choice, a number, true...). " +
      "For 'projects:task:status_changed|updated|created': {projectId} fires only for that project's " +
      "tasks, {fromStatusId} / {toStatusId} only for that status change (fromStatusId null: a task " +
      "created in toStatusId), {fields: {key: value | [values]}} only when the task's fields equal " +
      "(or are one of) those values. " +
      "Omit or null to react to every event the owner can read.",
  )
export type RoutineEventFilter = NonNullable<z.infer<typeof routineEventFilterSchema>>

/**
 * Who decides the gated drafts a routine raises (S29): 'default' = everyone
 * holding the tool's deciding scope; 'owner' = the routine owner alone. 'owner'
 * is accepted only when the owner holds the deciding scope.
 */
export const ROUTINE_APPROVERS = ["default", "owner"] as const
export type RoutineApprover = (typeof ROUTINE_APPROVERS)[number]
export const routineApproverSchema = z
  .enum(ROUTINE_APPROVERS)
  .optional()
  .describe(
    "Who approves the drafts this routine raises: 'default' (whoever may approve that action, e.g. " +
      "everyone handling a shared mailbox) or 'owner' (only the routine's owner, also on a shared " +
      "mailbox). 'owner' is refused when the owner may not approve those actions.",
  )

export const routineFollowUpSchema = z
  .boolean()
  .optional()
  .describe(
    "true: each run stages its drafts and ends, without waiting for their approval; " +
      "a staged mail checks again for a reply before it leaves.",
  )

/**
 * WHERE A ROUTINE POSTS ITS RUNS (`routines.report_thread_id`): a conversation
 * id, or a channel's handle (`#marketing`). The routine's owner must sit in
 * it; a routine's own output thread is refused. Null: only the routine's own
 * thread. Omitted on a create: the conversation it was asked in, else the
 * owner's chat with their personal agent when that agent runs it.
 */
export const routineReportThreadRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .nullable()
  .optional()
  .describe(
    "Where each run posts (its running status, the approvals it asks for and its final summary): " +
      "a conversation id, or a channel handle such as '#marketing'. The routine's owner must be a " +
      "member of it. Null: only the routine's own thread. Omit on create to post in this " +
      "conversation (or, outside one, in the owner's chat with their personal agent).",
  )

const createRoutineBaseSchema = z.object({
  name: routineNameSchema,
  title: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .nullable()
    .optional()
    .describe(
      "The routine's human name, shown in lists (e.g. 'Assign on status · Phone'). Null: show `name`.",
    ),
  description: z.string().min(1).max(200),
  kind: routineKindSchema.default("recurring"),
  cron: cronExpressionSchema.optional(),
  timezone: timezoneSchema.optional(),
  runAt: z.string().datetime().optional(),
  event: routineEventSchema.optional(),
  prompt: z.string().min(1).max(20_000),
  scopes: z
    .array(z.string().min(1).max(120))
    .max(1000)
    .default([])
    .describe(
      "The routine's scope CEILING — the MINIMAL set of EXACT 3-part scopes (app:resource:action) its " +
        "prompt actually calls. The routine runs AS its creator, so any scope the creator lacks is dropped. " +
        "POSTING the result needs NO write scope: the routine's output is auto-posted to its own output " +
        "thread by the runtime — it does NOT call a gated reply/post tool — so NEVER include kernel:threads:write, " +
        "kernel:threads:reply, mail:conversations:write, or any :write/:reply/:send scope just to 'post' or " +
        "'deliver' the digest/report/alert. A READ-ONLY digest/report/watch/triage routine (it only searches, " +
        "reads, and posts ONE summary) holds ONLY :read scopes. Include a :write/:reply scope ONLY when the " +
        "prompt itself performs that gated write on each tick (an auto-reply/refund/draft routine) — and then " +
        "each such action still lands as its own per-tick approval, it never auto-executes.",
    ),
  visibility: routineVisibilitySchema
    .default("personal")
    .describe(
      "Who SEES the routine's output. 'shared' = a TEAM routine: its auto-created output thread is " +
        "enrolled with EVERY active org member, so the digest/report the routine posts is visible to the " +
        "whole team — this is all you need for a team-wide digest ('post one ops digest so the team starts " +
        "the week aligned'); you do NOT have to pre-create a thread, setting " +
        "visibility:'shared' makes the output thread team-visible by itself. 'personal' (the default) = the " +
        "output thread is OWNER-PRIVATE (only the routine's owner sees it) — use it for a private/just-for-me " +
        "routine. So when the user wants the team to see a recurring digest, set visibility:'shared'.",
    ),
  enabled: z.boolean().default(true),
  // Run-as identity (delegation). Absent → the routine is owned by, and runs under the identity +
  // scope ceiling of, its CREATOR. When the user asks to build a routine FOR ANOTHER PERSON ("set up
  // a routine running as Liam …"), set this to that person's user id (resolve it with users_search):
  // the routine is then OWNED by them, runs under THEIR scopes, its gated actions land as approvals in
  // THEIR output thread, and its scope ceiling is capped at THEIR held scopes (so it pauses
  // `paused_scope_mismatch` on first tick if they lack a scope in `scopes`). Delegating to someone
  // else requires the creator to hold `kernel:routines:delegate` (or `*`); a self-owned routine
  // never needs it. A UUID — never a name.
  ownerUserId: z.string().uuid().optional(),
  // OWNING AGENT (the agent page's Routines tab, P4c-T32b). A DIFFERENT axis from
  // `ownerUserId`, which is the run-as human: this names the AGENT the routine
  // belongs to. Absent → the routine lands on the run-as user's own personal
  // agent, which is the only behaviour there was before. Present → the create
  // path resolves the agent under the caller's own visibility and applies the
  // A15 write rule (a role or system agent needs `kernel:agents:admin`; a
  // personal agent must be the caller's own; either way the caller's scopes must
  // cover that agent's ceiling). A refusal is an explicit error, never a silent
  // reassignment to the caller's own agent. A UUID — never a handle.
  ownerAgentId: z.string().uuid().optional(),
  // Per-routine agent model + reasoning override (nullable — absent/null means no
  // routine-level override, falling through to the output thread's own setting and
  // finally the org auto-select / off). Lets a routine be pinned to a specific model
  // BEFORE its output thread is lazily created on first tick. Any non-empty string is
  // accepted for agentModelId (mirrors the thread `agentModelId` validation — the
  // model catalog is enforced server-side by the credit meter, not here).
  agentModelId: z
    .string()
    .min(1)
    .max(200)
    .nullable()
    .optional()
    .describe(
      "Pin this routine's ticks to a specific model id (e.g. 'gemini-flash-latest'). Omit/null to fall " +
        "back to the output thread's own model setting, and finally the org auto-select.",
    ),
  agentReasoningLevel: reasoningLevelSchema
    .nullable()
    .optional()
    .describe(
      "Pin this routine's ticks to a reasoning level ('off'|'low'|'medium'|'high'). Omit/null to fall " +
        "back to the output thread's per-model reasoning setting, and finally 'off'.",
    ),
  tokenBudget: routineTokenBudgetSchema,
  hardTokenLimit: routineHardTokenLimitSchema,
  runsOn: routineRunsOnSchema,
  eventFilter: routineEventFilterSchema,
  approver: routineApproverSchema,
  followUp: routineFollowUpSchema,
  reportThreadId: routineReportThreadRefSchema,
  // The routine's flow (0303): its steps after the trigger. Null/absent = a legacy routine (one
  // agent step, its prompt). A flow routine still keeps a prompt: the plain summary of what it does.
  flow: routineFlowSchema.nullable().optional(),
})

const PROJECT_FILTER_KEYS = ["projectId", "fromStatusId", "toStatusId", "fields"] as const

/**
 * Whether an event filter fits its event: the projects keys only on a projects task event, and
 * from/to status only on `projects:task:status_changed`. Mirrors routines_event_filter_chk.
 */
export function routineEventFilterFitsEvent(
  event: string | null | undefined,
  filter:
    | ({
        projectId?: unknown
        fromStatusId?: unknown
        toStatusId?: unknown
        fields?: unknown
      } & Record<string, unknown>)
    | null
    | undefined,
): boolean {
  if (!filter) return true
  const projectKeys = PROJECT_FILTER_KEYS.filter((k) => filter[k] !== undefined)
  if (projectKeys.length === 0) return true
  if (!event || !(PROJECT_TASK_FILTER_EVENTS as readonly string[]).includes(event)) return false
  if (event !== "projects:task:status_changed") {
    return filter.fromStatusId === undefined && filter.toStatusId === undefined
  }
  return true
}

const EVENT_FILTER_MISFIT =
  "eventFilter projectId/fromStatusId/toStatusId/fields need event projects:task:status_changed " +
  "(fromStatusId/toStatusId) or projects:task:updated|created (projectId, fields)"

export const createRoutineRequestSchema = createRoutineBaseSchema
  .refine(kindColumnsValid, {
    message:
      "recurring routines need cron+timezone (no runAt); scheduled routines need runAt (no cron/timezone)",
  })
  .refine((v) => routineEventFilterFitsEvent(v.event, v.eventFilter), {
    message: EVENT_FILTER_MISFIT,
  })
export type CreateRoutineRequest = z.infer<typeof createRoutineRequestSchema>

/**
 * The update schema is every field optional with **no defaults** — a `.default()`
 * would silently fill `kind` on a description-only patch, making the refine
 * spuriously fire. It carries its own weaker refine: only validate the
 * kind/column relationship when `kind` is actually present in the patch — a kind
 * change must arrive with its matching schedule columns; a description-only
 * patch passes untouched.
 */
const updateRoutineBaseSchema = z.object({
  name: routineNameSchema.optional(),
  title: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .nullable()
    .optional()
    .describe(
      "The routine's human name, shown in lists (e.g. 'Assign on status · Phone'). Null: show `name`.",
    ),
  description: z.string().min(1).max(200).optional(),
  kind: routineKindSchema.optional(),
  cron: cronExpressionSchema.optional(),
  timezone: timezoneSchema.optional(),
  runAt: z.string().datetime().optional(),
  event: routineEventSchema.optional(),
  prompt: z.string().min(1).max(20_000).optional(),
  scopes: z.array(z.string().min(1).max(120)).max(1000).optional(),
  visibility: routineVisibilitySchema.optional(),
  enabled: z.boolean().optional(),
  agentModelId: z.string().min(1).max(200).nullable().optional(),
  agentReasoningLevel: reasoningLevelSchema.nullable().optional(),
  tokenBudget: routineTokenBudgetSchema,
  hardTokenLimit: routineHardTokenLimitSchema,
  runsOn: routineRunsOnSchema,
  eventFilter: routineEventFilterSchema,
  approver: routineApproverSchema,
  followUp: routineFollowUpSchema,
  // Where the routine POSTS its runs (0166): see routineReportThreadRefSchema.
  // The ONE "where it posts" field. The routine's own run thread
  // (`outputThreadId`) is internal: always its own, made on its first run, and
  // never set by a person or a tool.
  reportThreadId: routineReportThreadRefSchema,
  // The routine's flow (0303): its steps after the trigger. Null/absent = a legacy routine (one
  // agent step, its prompt). A flow routine still keeps a prompt: the plain summary of what it does.
  flow: routineFlowSchema.nullable().optional(),
})

export const updateRoutineRequestSchema = updateRoutineBaseSchema
  .refine((v) => v.event === undefined || routineEventFilterFitsEvent(v.event, v.eventFilter), {
    message: EVENT_FILTER_MISFIT,
  })
  .refine(
    (v) =>
      v.kind === undefined ||
      kindColumnsValid({
        kind: v.kind,
        cron: v.cron,
        timezone: v.timezone,
        runAt: v.runAt,
        event: v.event,
      }),
    {
      message:
        "a kind change must arrive with its matching schedule columns (cron+timezone for recurring, runAt for scheduled)",
    },
  )
export type UpdateRoutineRequest = z.infer<typeof updateRoutineRequestSchema>

export const routineResponseSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  name: routineNameSchema,
  title: z.string().nullable().optional(),
  description: z.string(),
  kind: routineKindSchema,
  cron: z.string().nullable(),
  timezone: z.string().nullable(),
  runAt: z.string().nullable(),
  event: z.string().nullable(),
  prompt: z.string(),
  outputThreadId: z.string().uuid().nullable(),
  reportThreadId: z.string().uuid().nullable().optional(),
  scopes: z.array(z.string()),
  visibility: routineVisibilitySchema,
  agentModelId: z.string().nullable(),
  agentReasoningLevel: reasoningLevelSchema.nullable(),
  tokenBudget: z.number().int().nullable(),
  hardTokenLimit: z.number().int().nullable(),
  runsOn: z.enum(ROUTINE_RUNS_ON).optional(),
  eventFilter: z
    .object({
      fromContactIds: z.array(z.string()).optional(),
      fromGroupIds: z.array(z.string()).optional(),
      tableId: z.string().optional(),
      column: z.string().optional(),
      to: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
      projectId: z.string().optional(),
      fromStatusId: z.string().nullable().optional(),
      toStatusId: z.string().optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
    })
    .nullable()
    .optional(),
  flow: z.unknown().nullable().optional(),
  approver: z.enum(ROUTINE_APPROVERS).optional(),
  followUp: z.boolean().optional(),
  enabled: z.boolean(),
  status: routineStatusSchema,
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.string().nullable(),
  lastRunError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type RoutineResponse = z.infer<typeof routineResponseSchema>

// ── Routine flow templates (0303) ────────────────────────────────────────────

/**
 * Fills a routine template's placeholders for one project: `{{projectId}}` becomes the project's
 * id and `{{status:<label>}}` the id of its status with that label (any case, spaces or
 * underscores alike). Pure; runs on the flow and the event filter alike, in the editor's prefill
 * and at enable time. A label the project has no status for is an error naming it.
 */
export function resolveRoutineTemplatePlaceholders<T>(
  value: T,
  project: { id: string; statuses: ReadonlyArray<{ id: string; label: string }> },
): { value: T } | { error: string } {
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "_")
  const byLabel = new Map(project.statuses.map((s) => [norm(s.label), s.id]))
  let missing: string | null = null
  const fill = (s: string): string =>
    s
      .replace(/\{\{\s*projectId\s*\}\}/g, project.id)
      .replace(/\{\{\s*status:([^}]+)\}\}/g, (_, label: string) => {
        const id = byLabel.get(norm(label))
        if (!id) missing ??= label.trim()
        return id ?? ""
      })
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return fill(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    }
    return v
  }
  const out = walk(value) as T
  if (missing) return { error: `the project has no status "${missing}"` }
  return { value: out }
}
