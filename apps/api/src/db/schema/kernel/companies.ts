// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import type { OrgAccess } from "./contacts"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * kernel.companies (migration 0293): the organisations an org's contacts work
 * for. Sharing has contacts' shape on `createdBy`, never on `ownerUserId`: the
 * account manager routes approvals and grants nothing. The trigger
 * `companies_sharing_guard` keeps `createdBy` immutable and the search ACL
 * columns derived for a request transaction.
 */
export const companies = kernel.table(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    handle: text("handle").notNull(),
    name: text("name").notNull(),
    /** Lowercase host, never a consumer domain. Not unique: a group's companies share one. */
    domain: text("domain"),
    description: text("description"),
    /** Soft reference to a contact, cleared by the merge and delete paths. */
    mainContactId: uuid("main_contact_id"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    metadata: jsonb("metadata"),
    notSameAs: uuid("not_same_as").array().notNull().default(sql`'{}'::uuid[]`),
    /** The relationship ended. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** Decides the company's sharing. Soft: a person merge re-points it. */
    createdBy: uuid("created_by"),
    /** The account manager: routes approvals, grants nothing. */
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    orgAccess: text("org_access").$type<OrgAccess>().notNull().default("editor"),
    /** Search ACL projection (kernel.recompute_search_acl). Never written directly. */
    aclUserIds: jsonb("acl_user_ids").$type<string[]>().notNull().default([]),
    aclRoleIds: jsonb("acl_role_ids").$type<string[]>().notNull().default([]),
    orgWide: boolean("org_wide").generatedAlwaysAs(sql`org_access IN ('viewer', 'editor')`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("companies_org_handle_idx").on(table.orgId, table.handle),
    index("companies_org_domain_idx")
      .on(table.orgId, sql`lower(${table.domain})`)
      .where(sql`domain IS NOT NULL`),
    index("companies_org_name_idx").on(table.orgId, sql`lower(${table.name})`),
    index("companies_owner_idx")
      .on(table.orgId, table.ownerUserId)
      .where(sql`owner_user_id IS NOT NULL`),
    check("companies_name_check", sql`length(trim(name)) > 0`),
    check("companies_org_access_check", sql`org_access IN ('none', 'viewer', 'editor')`),
    check("companies_restricted_has_creator", sql`org_access <> 'none' OR created_by IS NOT NULL`),
  ],
)

export type Company = typeof companies.$inferSelect
export type NewCompany = typeof companies.$inferInsert
