// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { agents } from "./agents"
import { kernel, organizations } from "./organizations"
import { threads } from "./threads"
import { users } from "./users"

export const routines = kernel.table(
  "routines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Desired end state (A15 / Migration sequencing design call, mirrors skills.ts T05): every
    // routine is owned by a named agent. The migration adds this column nullable and
    // unenforced; a later backfill task populates it and adds NOT NULL. ownerUserId stays
    // untouched as provenance (A15); routine name uniqueness stays (orgId, ownerUserId, name)
    // per D9 (only skill name uniqueness moves to the agent).
    // Kept nullable here to match the shipped migration (0048): every create path in this
    // slice resolves and writes a real owner, so in practice the column is never left NULL
    // going forward, but the Drizzle type must not require a field the SQL does not yet
    // enforce — 1b's backfill+NOT NULL migration is the point this becomes `.notNull()` here too.
    // The composite (owner_agent_id, org_id) foreign key lives in the table
    // config below (0072): the owner must be an agent of the ROUTINE'S OWN ORG.
    ownerAgentId: uuid("owner_agent_id"),
    name: text("name").notNull(),
    description: text("description").notNull(),
    kind: text("kind").notNull().default("recurring"),
    cron: text("cron"),
    timezone: text("timezone"),
    runAt: timestamp("run_at", { withTimezone: true }),
    event: text("event"),
    appName: text("app_name"),
    templateKey: text("template_key"),
    sourceKind: text("source_kind").notNull().default("user"),
    prompt: text("prompt").notNull(),
    outputThreadId: uuid("output_thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    // The conversation the routine reports to (0166): the thread it was asked
    // for in. Each tick's final message is posted there as the routine, so the
    // person sees the result where they asked. Null = output thread only.
    reportThreadId: uuid("report_thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    scopes: text("scopes").array().notNull(),
    // The part of `scopes` guessed from the prompt only (0136, P6-fix9): every
    // save recomputes it from the current prompt and keeps the explicit rest.
    // Null = a row written before it was recorded (see priorInferredScopes).
    inferredScopes: text("inferred_scopes").array(),
    visibility: text("visibility").notNull().default("personal"),
    // Per-routine agent model + reasoning override. Both nullable — null means "no
    // routine-level override", falling through to the output thread's own setting
    // (agentModelId / the per-model agentReasoningLevels map) and finally to the org
    // auto-select / off. Settable at create/update time and from the routine UI, so a
    // routine can be pinned to a specific model BEFORE its output thread is lazily
    // created on first tick (see agent-service.ts resolveRoutineTickModelOverride).
    agentModelId: text("agent_model_id"),
    agentReasoningLevel: text("agent_reasoning_level"),
    // Token budget + hard limit (0125, S17). Both nullable: null = none. The
    // budget is said to the agent in the tick prompt; the hard limit stops the
    // run once its cumulative tokens (input incl. cached + output, sub-runs
    // included) reach it.
    tokenBudget: integer("token_budget"),
    hardTokenLimit: integer("hard_token_limit"),
    // Where the routine runs (0129, S21): 'cloud' (default), 'node' (the
    // owner's node, queued with a push while it is offline) or
    // 'node_else_cloud' (the node when one is live, else the cloud).
    runsOn: text("runs_on", { enum: ["cloud", "node", "node_else_cloud"] })
      .notNull()
      .default("cloud"),
    // Where and with which Claude model a node run works (0140, L26): a shared
    // folder name, a repo URL, a model id. Unused by cloud runs, whose model
    // stays agentModelId (GAP5).
    folder: text("folder"),
    repo: text("repo"),
    model: text("model"),
    // Sender filter of a `mail:message:create` routine (0131, S26): evaluated
    // by the event routine subscriber as the owner, before any tick. Null = no filter.
    eventFilter: jsonb("event_filter").$type<{
      fromContactIds?: string[]
      fromGroupIds?: string[]
    } | null>(),
    // Who decides the gated drafts the routine raises (0131, S29): the tool's
    // deciding-scope audience, or the owner alone (only while the owner holds
    // the deciding scope; see approvals/resource-owner.ts).
    approver: text("approver", { enum: ["default", "owner"] })
      .notNull()
      .default("default"),
    enabled: boolean("enabled").notNull().default(true),
    // A routine that follows up on something sent, and ends when it is answered.
    followUp: boolean("follow_up").notNull().default(false),
    status: text("status").notNull().default("active"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunStatus: text("last_run_status"),
    lastRunError: text("last_run_error"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByActorType: text("created_by_actor_type").notNull(),
    // Who last changed the routine's definition (prompt, scopes, run-as), and
    // when (0230). Both NULL: unchanged since creation, so the creator is the
    // last editor. `editedAt` set with no editor: changed by a path that did
    // not say who (the 0230 trigger), which never counts as the owner.
    editedByUserId: uuid("edited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The owner agent must belong to the ROW'S OWN ORG (0072), the same guard
    // 0070 put on audit_log and 0071 on approval_requests. A key on
    // owner_agent_id alone checks existence only, so an org-A routine accepted
    // an org-B agent, and the audit row a tick then emits from that owner is
    // refused by audit_log's own guard, dead-lettering the tick's audit and
    // timeline rows. ON DELETE is unchanged (NO ACTION): deleting an agent that
    // still owns a routine is refused, which is what erase-user.ts relies on
    // when it clears the personal agent's routines before deleting it.
    foreignKey({
      columns: [t.ownerAgentId, t.orgId],
      foreignColumns: [agents.id, agents.orgId],
      name: "routines_agent_org_fk",
    }),
    index("routines_owner_agent_idx")
      .on(t.ownerAgentId, t.orgId)
      .where("owner_agent_id IS NOT NULL" as any),
    uniqueIndex("routines_unique_owner_name_idx").on(t.orgId, t.ownerUserId, t.name),
    index("routines_org_owner_idx").on(t.orgId, t.ownerUserId),
    index("routines_org_visibility_idx").on(t.orgId, t.visibility),
    check(
      "routines_status_chk",
      sql`${t.status} IN ('active','paused_scope_mismatch','paused_no_credits','paused_user','paused_app_disabled','completed')`,
    ),
    check("routines_kind_chk", sql`${t.kind} IN ('recurring','scheduled','event')`),
    check("routines_source_kind_chk", sql`${t.sourceKind} IN ('user','app','kernel')`),
    check("routines_visibility_chk", sql`${t.visibility} IN ('personal','shared')`),
    check(
      "routines_kind_columns_chk",
      sql`(${t.kind} = 'recurring' AND ${t.cron} IS NOT NULL AND ${t.timezone} IS NOT NULL AND ${t.runAt} IS NULL)
   OR (${t.kind} = 'scheduled' AND ${t.runAt} IS NOT NULL AND ${t.cron} IS NULL AND ${t.timezone} IS NULL)
   OR (${t.kind} = 'event' AND ${t.event} IS NOT NULL AND ${t.cron} IS NULL AND ${t.timezone} IS NULL AND ${t.runAt} IS NULL)`,
    ),
    check(
      "routines_created_by_actor_type_chk",
      sql`${t.createdByActorType} IN ('user','agent','mcp')`,
    ),
    check("routines_description_len_chk", sql`length(${t.description}) <= 200`),
    check("routines_prompt_min_chk", sql`length(${t.prompt}) >= 1`),
    check(
      "routines_agent_reasoning_level_chk",
      sql`${t.agentReasoningLevel} IS NULL OR ${t.agentReasoningLevel} IN ('off','low','medium','high')`,
    ),
    check("routines_token_budget_chk", sql`${t.tokenBudget} IS NULL OR ${t.tokenBudget} > 0`),
    check("routines_runs_on_chk", sql`${t.runsOn} IN ('cloud','node','node_else_cloud')`),
    check("routines_approver_chk", sql`${t.approver} IN ('default','owner')`),
    check("routines_folder_len_chk", sql`${t.folder} IS NULL OR char_length(${t.folder}) <= 200`),
    check("routines_repo_len_chk", sql`${t.repo} IS NULL OR char_length(${t.repo}) <= 500`),
    check("routines_model_len_chk", sql`${t.model} IS NULL OR char_length(${t.model}) <= 200`),
    check(
      "routines_event_filter_chk",
      sql`${t.eventFilter} IS NULL OR (jsonb_typeof(${t.eventFilter}) = 'object' AND ${t.event} = 'mail:message:create')`,
    ),
    check(
      "routines_hard_token_limit_chk",
      sql`${t.hardTokenLimit} IS NULL OR ${t.hardTokenLimit} > 0`,
    ),
  ],
)

export type Routine = typeof routines.$inferSelect
export type NewRoutine = typeof routines.$inferInsert
