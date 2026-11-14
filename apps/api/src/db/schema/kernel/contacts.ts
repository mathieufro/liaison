// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

/** What every org member gets on a shared resource (modules/sharing). */
export type OrgAccess = "none" | "viewer" | "editor"

export const contacts = kernel.table(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    handle: text("handle").notNull(),
    name: text("name"),
    email: text("email"),
    phone: text("phone"),
    company: text("company"),
    externalIds: jsonb("external_ids").$type<Record<string, string>>().default({}),
    metadata: jsonb("metadata"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Drive-style sharing (migration 0117, modules/sharing): the owner, and
     *  what every org member gets. Existing contacts are ownerless and 'editor'. */
    ownerUserId: uuid("owner_user_id"),
    orgAccess: text("org_access").$type<OrgAccess>().notNull().default("editor"),
    /** Search ACL projection, maintained by modules/sharing. Never written directly. */
    aclUserIds: jsonb("acl_user_ids").$type<string[]>().notNull().default([]),
    aclRoleIds: jsonb("acl_role_ids").$type<string[]>().notNull().default([]),
    /** The audience a restricted contact was made for ("mail:inbox=<id>",
     *  "tickets:team=<team>"); contacts are kept apart per audience. */
    audienceKey: text("audience_key"),
    orgWide: boolean("org_wide").generatedAlwaysAs(sql`org_access IN ('viewer', 'editor')`),
    /** The company the contact works for (0296), kernel.companies; set NULL
     *  when the company is deleted. `company` (free text) stays beside it. */
    companyId: uuid("company_id"),
    /** What is recorded about writing to this person (0296). NULL everywhere
     *  means unknown: nothing is claimed until someone who knows records it. */
    lawfulBasis: text("lawful_basis", {
      enum: ["consent", "customer", "professional_interest", "generic_address"],
    }),
    lawfulBasisSource: text("lawful_basis_source"),
    lawfulBasisAt: timestamp("lawful_basis_at", { withTimezone: true }),
    /** NULL = unknown, which a commercial send treats as a consumer. */
    isConsumer: boolean("is_consumer"),
    /** ISO 3166-1 alpha-2. */
    recipientCountry: text("recipient_country"),
    /** NULL = unknown, which the Art. 14 notice treats as a third party. */
    dataSource: text("data_source", { enum: ["direct", "third_party", "enrichment"] }),
    art14NoticeAt: timestamp("art14_notice_at", { withTimezone: true }),
  },
  (table) => [
    index("contacts_company_idx")
      .on(table.orgId, table.companyId)
      .where(sql`company_id IS NOT NULL`),
    uniqueIndex("contacts_org_email_idx")
      .on(table.orgId, table.email)
      .where(sql`org_access <> 'none'`),
    uniqueIndex("contacts_owned_email_idx")
      .on(table.orgId, table.ownerUserId, table.email)
      .where(sql`org_access = 'none' AND owner_user_id IS NOT NULL AND audience_key IS NULL`),
    uniqueIndex("contacts_audience_email_idx")
      .on(table.orgId, table.audienceKey, table.email)
      .where(sql`org_access = 'none' AND audience_key IS NOT NULL`),
    uniqueIndex("contacts_org_handle_idx").on(table.orgId, table.handle),
    index("contacts_tags_gin").using("gin", table.tags),
  ],
)

export const contactSegments = kernel.table(
  "contact_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    filter: jsonb("filter").$type<{ tag?: string; minSpend?: number }>().notNull().default({}),
    /** 'rule': a stored filter evaluated live. 'manual': a contact group whose
     *  members are hand-picked rows of contact_group_members (migration 0124). */
    kind: text("kind").$type<ContactSegmentKind>().notNull().default("rule"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("contact_segments_org_idx").on(table.orgId)],
)

export type ContactSegmentKind = "rule" | "manual"

/** A contact group's hand-picked members. RLS shows a row only when its
 *  contact is visible to the reader (migration 0124). */
export const contactGroupMembers = kernel.table(
  "contact_group_members",
  {
    segmentId: uuid("segment_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    orgId: uuid("org_id").notNull(),
    addedBy: uuid("added_by"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.segmentId, table.contactId] }),
    index("contact_group_members_contact_idx").on(table.orgId, table.contactId),
  ],
)

export type ContactAddressRole = "billing" | "delivery" | "other"
/** Where an address row came from (not whether anyone checked it). */
export type ContactAddressOrigin = "manual" | "import" | "order_sync" | "legacy_metadata"
/** What the person who verified an address checked it against. */
export type ContactAddressSource = "purchase_order" | "email" | "phone_call" | "other"

/**
 * A contact's address book (migration 0253). RLS shows a row only when its
 * contact is visible to the reader, and a write needs the contact editable.
 * Verification (`verifiedAt`, `verifiedBy`, `source`) is set all together or
 * not at all (CHECK); `verifiedBy` has no ON DELETE action, so a verified row
 * never loses its verifier while the verification stands.
 */
export const contactAddresses = kernel.table(
  "contact_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    role: text("role").$type<ContactAddressRole>().notNull().default("delivery"),
    label: text("label"),
    name: text("name"),
    company: text("company"),
    street1: text("street1"),
    street2: text("street2"),
    city: text("city"),
    postalCode: text("postal_code"),
    region: text("region"),
    countryIso2: text("country_iso2"),
    phone: text("phone"),
    email: text("email"),
    origin: text("origin").$type<ContactAddressOrigin>().notNull().default("manual"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: uuid("verified_by"),
    source: text("source").$type<ContactAddressSource>(),
    sourceNote: text("source_note"),
    sourceFileId: uuid("source_file_id"),
    staleAt: timestamp("stale_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("contact_addresses_contact_idx").on(table.orgId, table.contactId),
    check("contact_addresses_role_check", sql`${table.role} IN ('billing', 'delivery', 'other')`),
    check(
      "contact_addresses_origin_check",
      sql`${table.origin} IN ('manual', 'import', 'order_sync', 'legacy_metadata')`,
    ),
    check(
      "contact_addresses_source_check",
      sql`${table.source} IS NULL OR ${table.source} IN ('purchase_order', 'email', 'phone_call', 'other')`,
    ),
    check(
      "contact_addresses_verification_check",
      sql`(${table.verifiedAt} IS NULL) = (${table.verifiedBy} IS NULL) AND (${table.verifiedAt} IS NULL) = (${table.source} IS NULL)`,
    ),
  ],
)

/**
 * Addresses and domains staff marked as trusted senders for their org (migration 0154). A trusted
 * sender's mail without a provider verdict counts as verified for the inbound rules, and a trusted
 * address or domain counts as a known calendar guest. Never a public mail provider's domain.
 * Written only by the contacts trusted-senders routes (privileged, scope-checked, audited).
 */
export const trustedSenders = kernel.table(
  "trusted_senders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    kind: text("kind").$type<"address" | "domain">().notNull(),
    value: text("value").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("trusted_senders_org_kind_value_idx").on(table.orgId, table.kind, table.value),
  ],
)
