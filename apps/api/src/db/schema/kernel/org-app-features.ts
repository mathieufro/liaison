// SPDX-License-Identifier: FSL-1.1-ALv2
import { boolean, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * kernel.org_app_features: a switch inside an app, per org. A member reads their
 * own org's rows and has no write path under liaison_rls; writes go through one
 * kernel module on a privileged client, after the feature's admin scope is checked.
 */
export const orgAppFeatures = kernel.table(
  "org_app_features",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appName: text("app_name").notNull(),
    feature: text("feature").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    changedBy: uuid("changed_by").references(() => users.id, { onDelete: "set null" }),
    changedAt: timestamp("changed_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.appName, table.feature] })],
)

export type OrgAppFeature = typeof orgAppFeatures.$inferSelect
export type NewOrgAppFeature = typeof orgAppFeatures.$inferInsert
