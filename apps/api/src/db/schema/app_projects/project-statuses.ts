// SPDX-License-Identifier: FSL-1.1-ALv2
import { boolean, index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { appProjects, projects } from "./projects"

export const projectStatuses = appProjects.table(
  "project_statuses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    color: text("color"),
    order: integer("order").notNull(),
    terminal: boolean("terminal").notNull().default(false),
    // On a pipeline, the outcome a deal reaching this status gets (0295). Only
    // on a terminal status (check status_outcome_terminal).
    dealOutcome: text("deal_outcome", { enum: ["won", "lost"] }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_project_statuses_project_order").on(t.projectId, t.order)],
)
