// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { appProjects, projects } from "./projects"

/*
 * Reconciling a project's period (migration 0320). Tables and policies are
 * owned by the migration; these mirror it. Left out of the projects
 * manifest's schema block for the reason given in ./time.ts: a proposed
 * reconciliation is its creator's alone.
 */

export const RECONCILIATION_STATES = ["proposed", "drafted", "invoiced", "credited"] as const

export const reconciliations = appProjects.table(
  "reconciliations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    basis: text("basis").notNull(),
    state: text("state", { enum: RECONCILIATION_STATES }).notNull(),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").notNull(),
    threadId: uuid("thread_id"),
    notSeen: jsonb("not_seen").$type<unknown[]>().notNull().default([]),
    foot: jsonb("foot").$type<Record<string, unknown>>().notNull().default({}),
    excludedCount: integer("excluded_count").notNull().default(0),
    documentId: uuid("document_id"),
    waivedOverage: boolean("waived_overage").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT in the migration: drizzle cannot express it.
    uniqueIndex("reconciliations_proposed_uidx")
      .on(t.orgId, t.projectId, t.periodStart, t.createdBy)
      .where(sql`state = 'proposed'`),
    index("reconciliations_project_idx").on(t.projectId),
    index("reconciliations_creator_idx").on(t.createdBy),
  ],
)

export const reconciliationLines = appProjects.table(
  "reconciliation_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    reconciliationId: uuid("reconciliation_id")
      .notNull()
      .references(() => reconciliations.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name"),
    wording: text("wording"),
    why: text("why"),
    kind: text("kind", { enum: ["planned", "unplanned", "manual", "other"] }),
    reason: text("reason", { enum: ["our_mistake", "client_asked", "other_client"] }),
    taskIds: uuid("task_ids").array().notNull().default(sql`'{}'`),
    plannedMinutes: integer("planned_minutes"),
    realMinutes: integer("real_minutes"),
    realNoteMinutes: integer("real_note_minutes"),
    traceEstimateMinutes: integer("trace_estimate_minutes"),
    billMinutes: integer("bill_minutes").notNull().default(0),
    billedAfterCreditMinutes: integer("billed_after_credit_minutes"),
    documentLinePosition: integer("document_line_position"),
    /** The project this line's work belongs to, when it is not the card's own. */
    otherProjectId: uuid("other_project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reconciliation_lines_parent_idx").on(t.reconciliationId, t.position)],
)

export const RECONCILIATION_PROOF_KINDS = [
  "task",
  "commit",
  "pull_request",
  "merge_request",
  "calendar_event",
  "knowledge_doc",
  "mail",
  "ticket",
  "note",
] as const

/** A line's proof: a reference and a label of 60 characters at most. No body. */
export const reconciliationProofs = appProjects.table(
  "reconciliation_proofs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    lineId: uuid("line_id")
      .notNull()
      .references(() => reconciliationLines.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RECONCILIATION_PROOF_KINDS }).notNull(),
    ref: text("ref").notNull(),
    label: text("label").notNull(),
    url: text("url"),
    occurredOn: date("occurred_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reconciliation_proofs_line_idx").on(t.lineId)],
)

export const BILLING_CLAIM_STATES = [
  "reserved",
  "billed",
  "left_off",
  "released",
  "credited",
] as const

/** A source reserved or billed for a period: live claims are unique. */
export const billingClaims = appProjects.table(
  "billing_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id").notNull(),
    reconciliationId: uuid("reconciliation_id"),
    lineId: uuid("line_id"),
    sourceKind: text("source_kind").notNull(),
    sourceRef: text("source_ref").notNull(),
    periodKey: text("period_key").notNull(),
    state: text("state", { enum: BILLING_CLAIM_STATES }).notNull(),
    documentId: uuid("document_id"),
    documentNumber: text("document_number"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("billing_claims_live_uidx")
      .on(t.orgId, t.sourceKind, t.sourceRef, t.periodKey)
      .where(sql`state IN ('reserved', 'billed')`),
    index("billing_claims_project_idx").on(t.orgId, t.projectId),
    index("billing_claims_reconciliation_idx")
      .on(t.reconciliationId)
      .where(sql`reconciliation_id IS NOT NULL`),
  ],
)

export type Reconciliation = typeof reconciliations.$inferSelect
export type BillingClaim = typeof billingClaims.$inferSelect
