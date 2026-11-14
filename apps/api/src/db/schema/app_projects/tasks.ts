// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { threads } from "~/db/schema/kernel/threads"
import { users } from "~/db/schema/kernel/users"
import { projectStatuses } from "./project-statuses"
import { appProjects, projects } from "./projects"

export const tasks = appProjects.table(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    parentTaskId: uuid("parent_task_id").references((): any => tasks.id, {
      onDelete: "restrict",
    }),
    statusId: uuid("status_id")
      .notNull()
      .references(() => projectStatuses.id, { onDelete: "restrict" }),
    // Per-project sequential number allocated atomically from
    // projects.nextTaskNumber (0043) — displayed as "<project key>-<number>".
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    priority: text("priority").notNull().default("normal"),
    dueDate: date("due_date"),
    startDate: date("start_date"),
    // Free-text release (0106); filtering uses the effective release (own, else
    // nearest ancestor's).
    release: text("release"),
    // A task's timebox in minutes and its milestone mark (0319).
    timeboxMinutes: integer("timebox_minutes"),
    isMilestone: boolean("is_milestone").notNull().default(false),
    position: doublePrecision("position").notNull().default(1000),
    blocked: boolean("blocked").notNull().default(false),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // The agent that created the task, as its attribution label (0248); null
    // when a person did.
    createdByAgentLabel: text("created_by_agent_label"),
    // The task's field values {key: cell} (0302), checked against the project's task_fields.
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull().default({}),
    // When the task entered its current status (0302).
    statusEnteredAt: timestamp("status_entered_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_tasks_project_status_position").on(t.projectId, t.statusId, t.position),
    index("idx_tasks_project_parent_position").on(t.projectId, t.parentTaskId, t.position),
    index("idx_tasks_assignee_due").on(t.assigneeId, t.dueDate),
    uniqueIndex("app_projects_tasks_number_uidx").on(t.projectId, t.number),
    index("idx_tasks_org_release").on(t.orgId, sql`lower(${t.release})`),
    index("idx_tasks_assignee_timebox")
      .on(t.orgId, t.assigneeId)
      .where(sql`timebox_minutes IS NOT NULL AND archived_at IS NULL`),
  ],
)
