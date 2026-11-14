// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { bigint, check, index, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { projectStatuses } from "./project-statuses"
import { appProjects } from "./projects"
import { tasks } from "./tasks"

/**
 * app_projects.deals (migration 0314): a deal is a root task of a pipeline.
 * Read like the task (projects:projects:read), written with
 * projects:tasks:write. `companyId` and `contactId` are soft references to the
 * kernel, re-pointed or cleared by its merge and delete paths.
 */
export const deals = appProjects.table(
  "deals",
  {
    taskId: uuid("task_id")
      .primaryKey()
      .references(() => tasks.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull(),
    companyId: uuid("company_id"),
    contactId: uuid("contact_id"),
    outcome: text("outcome", { enum: ["open", "won", "lost"] })
      .notNull()
      .default("open"),
    nextStep: text("next_step"),
    lostReason: text("lost_reason"),
    reopenStatusId: uuid("reopen_status_id").references(() => projectStatuses.id, {
      onDelete: "set null",
    }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("deals_company_idx").on(t.orgId, t.companyId).where(sql`company_id IS NOT NULL`),
    index("deals_contact_idx").on(t.orgId, t.contactId).where(sql`contact_id IS NOT NULL`),
    index("deals_open_idx").on(t.orgId, t.outcome, t.closedAt),
    check("deals_closed_when_decided", sql`(outcome = 'open') = (closed_at IS NULL)`),
  ],
)

/**
 * app_projects.deal_values (migration 0314): a deal's amount, alone, so a
 * reader without projects:deals:read sees the deal and not its value. A new
 * deal's empty row comes from app_projects.ensure_deal_value(task).
 */
export const dealValues = appProjects.table(
  "deal_values",
  {
    taskId: uuid("task_id")
      .primaryKey()
      .references(() => deals.taskId, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }),
    currency: text("currency"),
    amountPeriod: text("amount_period", { enum: ["once", "month", "year"] })
      .notNull()
      .default("once"),
    probability: smallint("probability"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("deal_values_amount_has_currency", sql`(amount_minor IS NULL) = (currency IS NULL)`),
    check("deal_values_probability_check", sql`probability BETWEEN 0 AND 100`),
  ],
)

export type Deal = typeof deals.$inferSelect
export type DealValue = typeof dealValues.$inferSelect
