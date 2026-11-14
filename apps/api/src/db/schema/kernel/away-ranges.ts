// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  check,
  date,
  index,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * kernel.away_ranges: when someone is away. Dates, and never a reason:
 * `sourceEventRef` is `<calendar id>:<event id>`, not a title. Others in the org
 * read an active range; an `asked` or `declined` one is its person's alone. A
 * member has no direct write path, not on their own row either.
 */
export const awayRanges = kernel.table(
  "away_ranges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startsOn: date("starts_on").notNull(),
    // Inclusive, in the person's time zone. NULL only with weekdays.
    endsOn: date("ends_on"),
    // ISO days. NULL = every day of the range.
    weekdays: smallint("weekdays").array(),
    // NULL = the person's standing default.
    nextInLineId: uuid("next_in_line_id").references(() => users.id, { onDelete: "set null" }),
    source: text("source", { enum: ["said", "lead", "calendar"] }).notNull(),
    status: text("status", { enum: ["active", "asked", "declined"] })
      .notNull()
      .default("active"),
    sourceEventRef: text("source_event_ref"),
    endedEarlyOn: date("ended_early_on"),
    setBy: uuid("set_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("away_ranges_event_idx")
      .on(table.orgId, table.userId, table.sourceEventRef)
      .where(sql`source_event_ref IS NOT NULL`),
    index("away_ranges_person_idx").on(table.orgId, table.userId, table.startsOn),
    check("away_ranges_source_check", sql`source IN ('said', 'lead', 'calendar')`),
    check("away_ranges_status_check", sql`status IN ('active', 'asked', 'declined')`),
  ],
)

export type AwayRange = typeof awayRanges.$inferSelect
export type NewAwayRange = typeof awayRanges.$inferInsert
