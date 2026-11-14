// SPDX-License-Identifier: FSL-1.1-ALv2
import { index, text, timestamp, unique, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"

/**
 * kernel.suppressions (migration 0313): addresses the org must not send
 * commercial mail to, by fingerprint only:
 * `emailHash = sha256(orgId + ":" + lower(trim(email)))`, hex. No column can
 * hold the address. Read with mail:suppressions:read, added by anyone who
 * writes mail (mail:conversations:write) or holds mail:suppressions:write,
 * removed only with mail:suppressions:write, never updated.
 */
export const suppressions = kernel.table(
  "suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    emailHash: text("email_hash").notNull(),
    reason: text("reason", { enum: ["link", "reply", "person", "import"] }).notNull(),
    /** A mail message id or a user id, never the address. */
    source: text("source"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("suppressions_org_hash_key").on(t.orgId, t.emailHash)],
)

/**
 * kernel.suppression_links (migration 0313): opt-out link tokens, hashed. No
 * policy for the request role: only the privileged send path and the public
 * opt-out route read or write them.
 */
export const suppressionLinks = kernel.table(
  "suppression_links",
  {
    tokenHash: text("token_hash").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    emailHash: text("email_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("suppression_links_org_idx").on(t.orgId, t.createdAt)],
)

export type Suppression = typeof suppressions.$inferSelect
