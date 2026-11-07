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
  })
  .strict()
  .nullable()
  .optional()
  .describe(
    "Only for event 'mail:message:create': fire only on inbound mail whose sender is one of " +
      "fromContactIds (contact ids) or a member of one of fromGroupIds (contact group ids). Non-matching " +
      "mail never starts the routine. Omit or null to react to every new mail the owner can read.",
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
})

export const createRoutineRequestSchema = createRoutineBaseSchema.refine(kindColumnsValid, {
  message:
    "recurring routines need cron+timezone (no runAt); scheduled routines need runAt (no cron/timezone)",
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
})

export const updateRoutineRequestSchema = updateRoutineBaseSchema.refine(
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
    })
    .nullable()
    .optional(),
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
