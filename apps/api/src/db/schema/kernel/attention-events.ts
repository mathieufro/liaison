// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  jsonb,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * kernel.attention_events — persisted attention deliveries (Phase 10).
 *
 * Each row is one (user, parent entity, kind) attention delivery. The translation
 * worker writes rows from `kernel.pending_events`; digest workers read pending
 * rows by `digest_state`/`digest_eligible_at`.
 */
export const attentionEvents = kernel.table(
  "attention_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // I-DB-4 — org referential integrity + cascade.
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    app: text("app").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    kind: text("kind").notNull(),
    urgency: smallint("urgency").notNull(),
    summary: text("summary").notNull(),
    actorId: uuid("actor_id"),
    actorType: text("actor_type").notNull(),
    metadata: jsonb("metadata"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    // "Not now": out of the feed until this moment. NULL = not set aside.
    setAsideUntil: timestamp("set_aside_until", { withTimezone: true }),
    isUrgent: boolean("is_urgent").notNull().default(false),
    digestState: text("digest_state").notNull().default("pending"),
    digestEligibleAt: timestamp("digest_eligible_at", { withTimezone: true }).notNull(),
    emailOnly: boolean("email_only").notNull().default(false),
    sourceKey: text("source_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_attention_unread").on(table.orgId, table.userId).where(sql`read_at IS NULL`),
    index("idx_attention_digest")
      .on(table.digestState, table.digestEligibleAt)
      .where(sql`digest_state = 'pending'`),
    // A person's rows over a window, read or not (0251).
    index("attention_events_user_occurred_idx").on(table.userId, table.occurredAt),
    index("idx_attention_entity").on(table.orgId, table.app, table.entityType, table.entityId),
    uniqueIndex("idx_attention_unread_dedupe")
      .on(table.userId, table.app, table.entityType, table.entityId, table.kind)
      .where(sql`read_at IS NULL AND email_only = false`),
    uniqueIndex("idx_attention_email_only_source")
      .on(table.userId, table.sourceKey)
      .where(sql`email_only = true AND source_key IS NOT NULL`),
  ],
)

export type AttentionEvent = typeof attentionEvents.$inferSelect
export type NewAttentionEvent = typeof attentionEvents.$inferInsert
