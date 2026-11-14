// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { users } from "~/db/schema/kernel/users"
import { appProjects, projects } from "./projects"
import { tasks } from "./tasks"

/*
 * Time and budgets (migration 0319). The tables, their policies and the
 * definer functions app_projects.task_time_totals and
 * app_projects.project_time_cost are owned by the migration; these mirror it.
 * They are left out of the projects manifest's schema block on purpose: a
 * table declared there also gets the runtime's generated scope policies, which
 * Postgres ORs with the migration's, and `*` would then read every person's
 * time, rates and days per week.
 */

/** Hours in a day and the shared days-off calendar, one row per org. */
export const timeSettings = appProjects.table("time_settings", {
  orgId: uuid("org_id").primaryKey(),
  hoursPerDayMinutes: integer("hours_per_day_minutes").notNull().default(420),
  daysOffCalendarId: uuid("days_off_calendar_id"),
  updatedBy: uuid("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/** Days per week, 1 to 5, per person. No row reads 5. No weekday, no reason. */
export const personCapacity = appProjects.table(
  "person_capacity",
  {
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    daysPerWeek: smallint("days_per_week").notNull(),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    index("person_capacity_user_idx").on(t.userId),
    check("person_capacity_days_per_week_check", sql`days_per_week BETWEEN 1 AND 5`),
  ],
)

export const PROJECT_TIME_BASES = ["none", "hourly", "daily", "fixed", "retainer"] as const

/** A project's plan: basis, timebox, biller, dated hours and its repositories. */
export const projectTimePlan = appProjects.table(
  "project_time_plan",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull(),
    basis: text("basis", { enum: PROJECT_TIME_BASES }).notNull().default("none"),
    timeboxMinutes: integer("timebox_minutes"),
    billerId: uuid("biller_id").references(() => users.id, { onDelete: "set null" }),
    datedHours: boolean("dated_hours").notNull().default(false),
    datedHoursChangedBy: uuid("dated_hours_changed_by"),
    datedHoursChangedAt: timestamp("dated_hours_changed_at", { withTimezone: true }),
    sourceRepos: jsonb("source_repos").$type<unknown[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("project_time_plan_biller_idx").on(t.billerId).where(sql`biller_id IS NOT NULL`)],
)

/** Rate or fixed price, alone, behind projects:money:read and :write. */
export const projectBillingTerms = appProjects.table("project_billing_terms", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  orgId: uuid("org_id").notNull(),
  rateMinor: bigint("rate_minor", { mode: "number" }),
  fixedPriceMinor: bigint("fixed_price_minor", { mode: "number" }),
  currency: char("currency", { length: 3 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/** A project's timebox for one period. */
export const projectTimeboxes = appProjects.table(
  "project_timeboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    minutes: integer("minutes").notNull(),
    source: text("source", { enum: ["manual", "retainer"] }).notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_timeboxes_period_uidx").on(t.orgId, t.projectId, t.periodStart),
    index("project_timeboxes_project_idx").on(t.projectId),
    check("project_timeboxes_period_order", sql`period_end >= period_start`),
  ],
)

/** The minutes a person took on a task, on a day. Private to its person. */
export const taskTime = appProjects.table(
  "task_time",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    workDate: date("work_date").notNull(),
    minutes: integer("minutes").notNull(),
    enteredVia: text("entered_via", { enum: ["field", "agent", "mcp"] }).notNull(),
    changedBy: uuid("changed_by"),
    costMinor: bigint("cost_minor", { mode: "number" }),
    /** The currency of the rate a frozen cost came from; null is the org's. */
    costCurrency: text("cost_currency"),
    /** Entered while its project used dated hours: only such a row can join the dated sheet. */
    enteredDated: boolean("entered_dated").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("task_time_person_day_uidx").on(t.orgId, t.taskId, t.userId, t.workDate),
    index("task_time_project_day_idx").on(t.orgId, t.projectId, t.workDate),
    index("task_time_task_idx").on(t.taskId),
    index("task_time_user_idx").on(t.userId).where(sql`user_id IS NOT NULL`),
    index("task_time_project_idx").on(t.projectId),
    check("task_time_minutes_check", sql`minutes > 0 AND minutes <= 44640`),
  ],
)

/** A person's cost rate from a date. Read and written by exact scope only. */
export const costRates = appProjects.table(
  "cost_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rateMinor: bigint("rate_minor", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }),
    effectiveFrom: date("effective_from").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cost_rates_person_from_uidx").on(t.orgId, t.userId, t.effectiveFrom),
    index("cost_rates_user_idx").on(t.userId),
  ],
)

/** Company days off. One person's days are away days, not rows here. */
export const daysOff = appProjects.table(
  "days_off",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    recursYearly: boolean("recurs_yearly").notNull().default(false),
    label: text("label"),
    sourceEventId: uuid("source_event_id"),
    createdBy: uuid("created_by"),
    createdVia: text("created_via", { enum: ["settings", "agent", "calendar"] }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("days_off_span_uidx").on(t.orgId, t.startsOn, t.endsOn, t.recursYearly),
    check("days_off_order", sql`ends_on >= starts_on`),
    check("days_off_yearly_span", sql`NOT recurs_yearly OR ends_on - starts_on <= 31`),
  ],
)

export type TaskTime = typeof taskTime.$inferSelect
export type ProjectTimePlan = typeof projectTimePlan.$inferSelect
export type DayOff = typeof daysOff.$inferSelect
