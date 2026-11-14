// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import {
  bigint,
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

export const agentMemory = kernel.table(
  "agent_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Nullable (rekey, migration 0055): ownership moved to ownerAgentId. A role
    // or system agent's memory row has no owning human, so userId stays only
    // as the slice-1b bridge — see memory-rekey design note in 0055.
    userId: uuid("user_id").references(() => users.id),
    // Nullable in Drizzle ahead of a later backfill-then-NOT-NULL step, matching
    // the precedent set for skills.ownerAgentId / routines.ownerAgentId
    // (review commit d390da26): declaring .notNull() here ahead of the
    // migration's own nullable column produces spurious TS errors everywhere
    // a memory row is constructed.
    // The composite (owner_agent_id, org_id) foreign key lives in the table
    // config below (0072): the owner must be an agent of the ROW'S OWN ORG.
    ownerAgentId: uuid("owner_agent_id"),
    type: text("type").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    content: text("content").notNull(),
    // D5 provenance (0055), with the DEFAULT dropped in 0065: every writer
    // supplies the turn's scopes explicitly, so an untagged insert fails
    // instead of landing as the empty set every member satisfies.
    requiredScopes: text("required_scopes").array().notNull(),
    // --- The plaintext memory tree (0081) ----------------------------------
    // The file the model and the humans see is RENDERED from these columns:
    // a YAML frontmatter block plus `content` as the Markdown body. Parsing a
    // written file puts the frontmatter BACK here, so the columns stay the
    // source of truth for RLS and scopes and a body claiming a wider
    // `requiredScopes` about itself changes nothing.
    //
    // `path` is nullable until 0083 backfills it (`MEMORY.md` for the reserved
    // index row, `<type>/<name>.md` otherwise); 0083 also owns the partial
    // unique index on (orgId, ownerAgentId, path).
    path: text("path"),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
    lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true }),
    recallCount: integer("recall_count").notNull().default(0),
    // Supersession, never deletion: the new row points at the one it replaces
    // and the old row gets `supersededAt`. SET NULL on the key, so erasure can
    // still delete a whole chain in one pass and a delete never cascades into
    // the surviving current row.
    supersedesId: uuid("supersedes_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    sourceThreadId: uuid("source_thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    sourceMessageId: uuid("source_message_id"),
    sourceKind: text("source_kind").notNull().default("agent"),
    /**
     * Set when a message this row's episode summarizes is deleted, cleared
     * when the artefact is rebuilt without it (0086). Mutable in both
     * directions, like the checkpoint column it mirrors.
     */
    staleAt: timestamp("stale_at", { withTimezone: true }),
    episodeFromMessageId: uuid("episode_from_message_id"),
    episodeToMessageId: uuid("episode_to_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The owning agent must belong to the ROW'S OWN ORG (0072). Memory is read
    // back BY OWNING AGENT, so a cross-org owner was a cross-tenant read of
    // stored content, not just a mislabelled row. ON DELETE is unchanged
    // (NO ACTION): erase-user.ts deletes the personal agent's memory rows
    // before deleting the agent because this key refuses the delete otherwise.
    foreignKey({
      columns: [table.ownerAgentId, table.orgId],
      foreignColumns: [agents.id, agents.orgId],
      name: "agent_memory_agent_org_fk",
    }),
    uniqueIndex("agent_memory_org_owner_type_name_idx").on(
      table.orgId,
      table.ownerAgentId,
      table.type,
      table.name,
    ),
    index("agent_memory_user_idx").on(table.orgId, table.userId),
    // The tree's own key (0083). Partial on a non null path so a row written
    // by an older build is never refused.
    uniqueIndex("agent_memory_org_owner_path_idx")
      .on(table.orgId, table.ownerAgentId, table.path)
      .where(drizzleSql`path IS NOT NULL`),
    // Self reference (0081): the row this one supersedes. SET NULL, so account
    // erasure deleting a whole chain in one pass is never blocked and a delete
    // never takes the surviving current row with it.
    foreignKey({
      columns: [table.supersedesId],
      foreignColumns: [table.id],
      name: "agent_memory_supersedes_fk",
    }).onDelete("set null"),
    check(
      "agent_memory_type_check",
      drizzleSql`type IN ('user','feedback','project','reference','episode','_index')`,
    ),
    check(
      "agent_memory_source_kind_check",
      drizzleSql`source_kind IN ('agent','human','consolidation','migration')`,
    ),
  ],
)

/**
 * The last approval handle number (`request-N`) each organisation used (0215).
 * Handles are numbered per organisation, so one tenant's numbers say nothing
 * about another's. Bumped by `nextApprovalHandle` (lib/handle.ts).
 */
export const approvalHandleCounters = kernel.table("approval_handle_counters", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  lastValue: bigint("last_value", { mode: "number" }).notNull(),
})

export const approvalRequests = kernel.table(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    handle: text("handle").notNull(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id),
    originatingThreadId: uuid("originating_thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "restrict" }),
    toolName: text("tool_name").notNull(),
    toolParams: jsonb("tool_params").notNull(),
    currentPayload: jsonb("current_payload").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    notifyUserIds: uuid("notify_user_ids").array().notNull().default(drizzleSql`'{}'::uuid[]`),
    approvingStartedAt: timestamp("approving_started_at", { withTimezone: true }),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    status: text("status").notNull().default("pending"),
    reason: text("reason"),
    summary: jsonb("summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // Set when the gated tool targets a PERSONALLY-owned resource (e.g. a mail
    // reply from a personal mailbox): the resolved owner's user id. Such
    // approvals are privately routed — visible and decidable only by the
    // requester and this owner (see migration 0028). Null = org/shared resource.
    resourceOwnerId: uuid("resource_owner_id").references(() => users.id),
    // The one person this approval is routed to. NULL = the usual deciders.
    routePersonId: uuid("route_person_id").references(() => users.id, { onDelete: "set null" }),
    // The company it is routed for; no foreign key until that table exists.
    // FK -> kernel.companies ON DELETE SET NULL (0293); a merge re-points it first.
    routeCompanyId: uuid("route_company_id"),
    // Custom decision scope for this approval (dimension-constrained approvals,
    // migration 0029). Overrides the derived `<app>:approve`. Null = derived.
    approveScope: text("approve_scope"),
    // Optional dimension grant the decider (and notified audience) must cover to
    // decide this approval, e.g. { key: "kernel:skills_domain", values: ["shipping"] }.
    // Null = unconstrained. Enforced in decide.ts / the eligible-approver audience.
    dimensionConstraint: jsonb("dimension_constraint").$type<{
      key: string
      values: string[]
    } | null>(),
    bundleId: uuid("bundle_id"),
    bundlePosition: integer("bundle_position"),
    dependsOnId: uuid("depends_on_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Acting agent identity (P2b-T04, migration 0063), mirroring
    // audit_log.agentId (0061): independent of requestedBy (the human), null
    // on every non-agent-originated approval. Agents are archived rather than
    // deleted, so SET NULL only fires on org deletion or a personal agent's
    // erasure, and never blocks either. The foreign key is COMPOSITE and lives
    // in the table config below (0071).
    agentId: uuid("agent_id"),
    // FX4 (migration 0067): the scopes the PROPOSING turn had accumulated when
    // this gated call was deferred. The approved re-entry runs outside that
    // turn's ALS frame, so without this every scope-tagged write it makes lands
    // `{}` (world-readable) while the same call made inline carries the turn's
    // scopes. NULL is meaningful and distinct from `{}`: nothing was recorded
    // (a pre-0067 row, or a turn whose taint was unknowable), and the re-entry
    // fails closed to the requester's full scope set rather than to `{}`.
    proposingTurnScopes: text("proposing_turn_scopes").array(),
  },
  (table) => [
    uniqueIndex("approval_requests_org_handle_idx").on(table.orgId, table.handle),
    index("approval_requests_org_status_idx").on(table.orgId, table.status),
    index("approval_requests_org_status_expires_idx").on(
      table.orgId,
      table.status,
      table.expiresAt,
    ),
    index("approval_requests_notify_users_idx").using("gin", table.notifyUserIds),
    index("approval_requests_bundle_idx").on(table.bundleId, table.bundlePosition),
    index("approval_requests_depends_on_idx").on(table.dependsOnId),
    // The agent must belong to the ROW'S OWN ORG (0071), the same guard 0070
    // put on audit_log. A foreign key on agent_id alone checks existence only,
    // so org A's approval could name org B's agent, and the identity it seeds
    // into the approved re-entry then failed every audit insert that re-entry
    // made. The migration spells the delete rule as
    // `ON DELETE SET NULL (agent_id)`, which nulls the agent and keeps the
    // approval row (and its NOT NULL org_id); Drizzle's builder cannot express
    // that column list, so the rule lives in the SQL and this declaration
    // carries the columns only.
    foreignKey({
      columns: [table.agentId, table.orgId],
      foreignColumns: [agents.id, agents.orgId],
      name: "approval_requests_agent_org_fk",
    }),
    index("approval_requests_agent_idx")
      .on(table.agentId)
      .where("agent_id IS NOT NULL" as any),
  ],
)

export const approvedHandlerExecutions = kernel.table(
  "approved_handler_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    approvalRequestId: uuid("approval_request_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "restrict" }),
    toolName: text("tool_name").notNull(),
    status: text("status").notNull(),
    externalRef: jsonb("external_ref"),
    error: jsonb("error"),
    result: jsonb("result"), // decided gated tool result — written once on success, read by liaison_approval_status
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("approved_handler_executions_approval_request_id_tool_name_key").on(
      table.approvalRequestId,
      table.toolName,
    ),
    index("approved_handler_executions_request_idx").on(table.approvalRequestId),
    index("approved_handler_executions_status_idx").on(table.status, table.startedAt),
    check(
      "approved_handler_executions_status_check",
      drizzleSql`${table.status} IN ('started','succeeded','awaiting_output','failed_no_effect','ambiguous')`,
    ),
  ],
)
