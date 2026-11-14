// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ApprovalSummary } from "@liaison/shared"
import { and, sql as drizzleSql, eq, inArray } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { RlsClient, RlsTx } from "~/db"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import {
  type ContactAddressRole,
  type ContactAddressSource,
  companies as companiesTable,
  contactSegments,
  contacts as contactsTable,
  users as usersTable,
} from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { UUID_RE } from "~/lib/uuid"
import { linkedAppLine, readLinkedRecords } from "~/modules/contacts/activity"
import {
  type AddressFields,
  addAddress,
  assertVerifiable,
  type ContactAddress,
  formatAddressLine,
  getAddress,
  listAddresses,
  readableFile,
  updateAddress,
  type VerifyAddressParams,
  verifyAddress,
} from "~/modules/contacts/addresses"
import {
  addGroupMembers,
  createGroup,
  deleteGroup,
  getGroup,
  listGroupMembers,
  listGroups,
  removeGroupMembers,
  renameGroup,
} from "~/modules/contacts/groups"
import {
  exportContactsToFile,
  findDuplicateClusters,
  getContact,
  listContacts,
  mergeContactsWithMailReferences,
  resolveContact,
  updateContact,
} from "~/modules/contacts/service"
import { getContactSharing, setContactSharing } from "~/modules/contacts/sharing"
import { loadOrgSettings, wouldExceedOrgQuota } from "~/modules/files/service"
import { actorGrantRole } from "~/modules/sharing/service"

const log = rootLogger.child({ module: "contact-tools" })

interface ContactToolContext {
  userId: string
  orgId: string
  db: RlsClient
  scopes?: string[]
  /** The agent the call acts as, when an agent drafted it (execute-tool sets it). */
  actingAgentId?: string | null
  /** The app that called app-to-app, when one did (execute-tool sets it). */
  callerApp?: string
  dimensionGrants?: UserContext["dimensionGrants"]
  /** The person's roles: a record shared to one of them is theirs to read. */
  roles?: UserContext["roles"]
}

/**
 * Schema-qualified table for raw SQL, resolved per call through `schemaRef`. A
 * fixed `app_mail.` or `kernel.` reads the unprefixed schema under a
 * SCHEMA_PREFIX deployment and silently answers from the wrong rows.
 */
function tableRef(schema: string, table: string) {
  return drizzleSql.raw(`${quoteIdent(schemaRef(schema))}.${quoteIdent(table)}`)
}

/**
 * Extract a contact's WEBSITE / store URL from its free-form `metadata` for the contacts_search result.
 * A contact URL has no first-class column (per the field-placement rule it lives in `metadata`), but a
 * "search a tagged set then kernel__web_watch each page" routine (dealer-price-watch, competitor-watch) needs the
 * per-source URL off the SEARCH result — without it the routine has no page to poll. Probe the common
 * metadata keys a URL lands under (`storeUrl` first — the dealer-watch seed's key — then `website` / `url`
 * / `productUrl`). Returns the first http(s) string found, else null. Pure +
 * defensive (metadata is untyped jsonb): a non-object / non-string value yields null, never throws.
 */
export function contactWebsite(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null
  const m = metadata as Record<string, unknown>
  for (const key of ["storeUrl", "website", "url", "productUrl", "siteUrl"]) {
    const v = m[key]
    if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) return v.trim()
  }
  return null
}

/**
 * Run an OPTIONAL enrichment query and DEGRADE to an empty list if it fails (e.g. an RLS / cross-app
 * "permission denied" for a persona/app that lacks the relevant app scope). Used for contact-360
 * sections (mail backlinks, activity timeline) that must never crash the whole contacts_read tool —
 * the contact's own fields still return.
 *
 * CRITICAL: the query runs inside a SAVEPOINT (`db.transaction`). A bare try/catch is NOT enough — a
 * Postgres permission error ABORTS the surrounding transaction, so even though the JS error is caught,
 * the NEXT query (the second enrichment, or the bridge's work after the handler) then fails with
 * "current transaction is aborted" and the whole tool throws anyway. This was the failure that made a
 * cross-app `kernel:contacts_read` (boxtal pre-filling a recipient address) return `status:error`
 * despite the documented degrade — the conversations permission-denied poisoned the transaction
 * (BL-242). Wrapping the query in a savepoint rolls back ONLY the failed enrichment, leaving the outer
 * transaction healthy so the contact's core fields (and any later query) still succeed.
 *
 * `build` receives a tx handle (the savepoint) and returns the query promise; pass `ctx.db` as `db`.
 * Exported for a focused regression test.
 */
export async function safeEnrichmentRows<T>(
  db: Pick<RlsClient, "transaction">,
  build: (tx: RlsTx) => Promise<unknown>,
): Promise<T[]> {
  try {
    return await db.transaction(async (tx) => extractRows<T>(await build(tx)))
  } catch {
    return []
  }
}

export async function handleContactsSearch(
  params: {
    query?: string
    limit?: number
    cursor?: string
    tag?: string
    notContactedSince?: string
    createdAfter?: string
    createdWithinDays?: number
    hasNoCompany?: boolean
    hasNoPhone?: boolean
  },
  ctx: ContactToolContext,
) {
  const limit = Math.min(params.limit ?? 20, 50)
  const page = params.cursor ? Math.max(1, Number(params.cursor) || 1) : 1
  const { rows, total } = await listContacts(ctx.db, {
    orgId: ctx.orgId,
    page,
    limit,
    query: params.query,
    tag: params.tag,
    notContactedSince: params.notContactedSince,
    createdAfter: params.createdAfter,
    createdWithinDays: params.createdWithinDays,
    hasNoCompany: params.hasNoCompany,
    hasNoPhone: params.hasNoPhone,
  })

  return {
    items: rows.map((contact) => {
      const noCompany = contact.company == null || String(contact.company).trim() === ""
      const noPhone = contact.phone == null || String(contact.phone).trim() === ""
      return {
        id: contact.id,
        name: contact.name,
        primaryEmail: contact.email,
        company: contact.company,
        // BL-275: surface a contact's WEBSITE / store URL directly off the search result. A URL has no
        // dedicated column (per the field-placement rule it lives in `metadata`), so it was invisible to
        // contacts_search — only contacts_read returned it. That blocked the natural pattern of
        // "search a tagged set of dealers/competitors, then kernel__web_watch each one's page in a routine": the
        // agent could see the names but not the URLs, so a dealer-price-watch routine had no per-source
        // URL to poll (it fell back to guessed/unreachable URLs → empty fetches → no cross-tick diff).
        // Surface the URL from the common metadata keys (storeUrl / website / url) so ONE
        // contacts_search(tag:'dealer') yields every dealer's page URL the routine prompt needs — no
        // per-contact contacts_read fan-out. null when the contact carries no URL.
        website: contactWebsite(contact.metadata),
        // BL-FIRST: surface phone + createdAt so a bare/recently-created sweep can read field-emptiness
        // and creation recency DIRECTLY off the search result (no per-contact contacts_read needed). The
        // `hasNoCompany`/`hasNoPhone`/`createdAfter` filters select the set; these fields let the tick
        // verify + report which fields it is filling and that the contact is genuinely recent.
        phone: contact.phone ?? null,
        createdAt: contact.createdAt ?? null,
        // Explicit per-row emptiness flags so the flash-lite tick RENDERS the bare predicate instead of
        // re-deriving "company is null/empty" in-context (the l710/l711/l713/l714 doctrine).
        isBare: noCompany || noPhone,
        missingCompany: noCompany,
        missingPhone: noPhone,
        tags: contact.tags ?? [],
        // BL-258: surface the server-computed last-contacted recency the UI already sorts by, so the
        // agent can answer "haven't emailed in N days" honestly (null = never contacted). The
        // `notContactedSince` filter selects this set directly; this field lets the agent verify/report it.
        lastContactedAt: contact.lastContactedAt ?? null,
      }
    }),
    totalCount: total,
    nextCursor: page * limit < total ? String(page + 1) : undefined,
  }
}

/**
 * A contact's identifiers only (id, email, company id), for an app's own internal check (the
 * invoicing issuer guard). It returns none of the text people outside the org wrote (mail
 * subjects, snippets, notes), so unlike contacts_read it does not mark the turn as having read
 * outside text.
 */
export async function handleContactsIdentity(
  params: { contactId: string },
  ctx: ContactToolContext,
) {
  const [row] = await ctx.db
    .select({
      id: contactsTable.id,
      email: contactsTable.email,
      companyId: contactsTable.companyId,
    })
    .from(contactsTable)
    .where(and(eq(contactsTable.id, params.contactId), eq(contactsTable.orgId, ctx.orgId)))
    .limit(1)
  if (!row) {
    return {
      error: {
        code: "NOT_FOUND",
        message: `Contact not found: ${params.contactId}. Nothing was read.`,
      },
    }
  }
  return { contact: { id: row.id, email: row.email ?? null, companyId: row.companyId ?? null } }
}

export async function handleContactsRead(
  params: {
    contactId: string
    includeBacklinks?: boolean
    backlinksLimit?: number
    includeTimeline?: boolean
  },
  ctx: ContactToolContext,
) {
  const contact = await getContact(ctx.db, { orgId: ctx.orgId, contactId: params.contactId })
  if (!contact) return { error: { code: "NOT_FOUND", message: "Contact not found" } }

  // Mail backlinks + the activity timeline are OPTIONAL contact-360 enrichment. A persona WITHOUT
  // app_mail read scope (e.g. a finance persona reading a dealer contact) gets an RLS
  // "permission denied for table conversations" here — that must DEGRADE to empty, NEVER throw and
  // crash the whole contacts_read tool. A missing optional enrichment is not a tool failure; the
  // contact's own fields (incl. its email) still come back. (If a persona genuinely should see mail
  // backlinks, that is a scope/RLS grant — orthogonal to this crash-safety guarantee.)
  const backlinksLimit = Math.min(params.backlinksLimit ?? (params.includeBacklinks ? 20 : 3), 50)
  const backlinks = await safeEnrichmentRows<{
    id: string
    subject: string | null
    snippet: string | null
    email_address: string
    last_message_at: Date | null
  }>(ctx.db, (tx) =>
    tx.execute(drizzleSql`
    SELECT c.id, c.subject, c.snippet, a.email_address, c.last_message_at
    FROM ${tableRef("app_mail", "conversations")} c
    JOIN ${tableRef("app_mail", "accounts")} a ON a.id = c.account_id
    WHERE c.org_id = ${ctx.orgId} AND c.contact_id = ${params.contactId}
    ORDER BY c.last_message_at DESC NULLS LAST
    LIMIT ${backlinksLimit}
  `),
  )

  const timelineLimit = params.includeTimeline ? 20 : 3
  const timeline = await safeEnrichmentRows<{
    actor_id: string | null
    actor_type: string
    action: string
    summary: string
    created_at: Date
  }>(ctx.db, (tx) =>
    tx.execute(drizzleSql`
    SELECT actor_id, actor_type, action, summary, created_at
    FROM ${tableRef("kernel", "timeline_entries")}
    WHERE org_id = ${ctx.orgId} AND app = 'kernel' AND entity_type = 'contact' AND entity_id = ${params.contactId}
    ORDER BY created_at DESC
    LIMIT ${timelineLimit}
  `),
  )

  // An app reading a contact app-to-app (a recipient prefill) gets the contact alone.
  const linkedRecords = ctx.callerApp ? [] : await linkedRecordLines(params.contactId, ctx)

  return {
    contact: {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      company: contact.company,
      externalIds: contact.externalIds,
      metadata: contact.metadata,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
    },
    recentMailBacklinks: backlinks.map((backlink) => ({
      id: backlink.id,
      subject: backlink.subject,
      snippet: (backlink.snippet ?? "").slice(0, 200),
      accountEmail: backlink.email_address,
      lastMessageAt: backlink.last_message_at,
    })),
    recentTimeline: timeline.map((entry) => ({
      actorId: entry.actor_id,
      actorType: entry.actor_type,
      action: entry.action,
      summary: entry.summary,
      occurredAt: entry.created_at,
    })),
    ...(linkedRecords.length > 0 ? { linkedRecords } : {}),
  }
}

/** Mail is already in the result as its backlinks. */
const LINKED_SKIP = ["mail"]

/**
 * One line per other app that holds records for the contact, read as the
 * caller through each app's timeline source: what the caller may not read is
 * absent, never named. A source that did not answer says so.
 */
async function linkedRecordLines(contactId: string, ctx: ContactToolContext): Promise<string[]> {
  // Always the person: the call's provenance (agent, mcp) is not a row-security actor, and a
  // non-person actor would read with every dimension.
  const actor: UserContext = {
    actorType: "user",
    userId: ctx.userId,
    orgId: ctx.orgId,
    scopes: ctx.scopes ?? [],
    dimensionGrants: ctx.dimensionGrants ?? {},
    roles: ctx.roles,
  }
  try {
    const linked = await readLinkedRecords({
      orgId: ctx.orgId,
      actor,
      contactId,
      skip: LINKED_SKIP,
    })
    if (!linked) return []
    return [
      ...linked.apps.map(linkedAppLine),
      ...linked.unavailable.map(
        (u) => `${u.label}: not read (${u.reason === "timeout" ? "no answer in time" : "error"}).`,
      ),
    ]
  } catch (err) {
    log.warn({ err, contactId }, "contact read: other apps' records not read")
    return ["Other apps' records for this contact were not read (error)."]
  }
}

/**
 * BL-25: the field of record for a contact's VAT number is `externalIds.vat_id` — the invoicing
 * tax logic reads `counterparty.vat_id` from it (issue.ts), and that key drives export vs
 * reverse-charge treatment. A weak agent correcting a VAT routinely writes it into the free-form
 * `metadata` (`metadata.vat_id` / `metadata.vat_number`) instead, so the correction never reaches
 * the field of record and the stale number keeps driving treatment. Lift a VAT-shaped value out of
 * metadata into `externalIds.vat_id` (an explicit `externalIds.vat_id` always wins). Mirrors
 * invoicing's `liftMisplacedHsCode` (BL-39) — fix the weak-model field-placement at the boundary,
 * mechanically, rather than relying on prompt text alone.
 */
export function liftMisplacedVatId(
  externalIds: Record<string, string> | undefined,
  metadata: Record<string, unknown> | undefined,
): { externalIds?: Record<string, string>; metadata?: Record<string, unknown> } {
  if (!metadata || externalIds?.vat_id) return { externalIds, metadata }
  const raw = metadata.vat_id ?? metadata.vat_number
  if (typeof raw !== "string" || raw.trim() === "") return { externalIds, metadata }
  const restMetadata = { ...metadata }
  delete restMetadata.vat_id
  delete restMetadata.vat_number
  return {
    externalIds: { ...(externalIds ?? {}), vat_id: raw.trim() },
    metadata: Object.keys(restMetadata).length > 0 ? restMetadata : undefined,
  }
}

/**
 * enrich-dealer-contact-from-website: a contact's field of record for its phone is the first-class
 * `phone` column (the detail view renders it from there). A weak agent enriching a contact routinely
 * nests the fetched number under the free-form `metadata` (`metadata.phone`) instead of passing the
 * top-level `phone` arg, so the dedicated column stays NULL and the detail-view phone field renders
 * empty even though the value was captured. Lift a metadata phone out into the top-level `phone` when
 * no explicit top-level phone was given (an explicit top-level `phone` always wins). Mirrors
 * `liftMisplacedVatId` (BL-25) / invoicing's `liftMisplacedHsCode` (BL-39): fix the weak-model field-
 * placement at the boundary, mechanically, rather than relying on prompt text alone. This is field
 * NORMALIZATION (route a misplaced value to its column of record), not a failure-masking fallback —
 * the value the agent captured persists where it belongs instead of being silently stranded.
 */
export function liftMisplacedPhone(
  phone: string | undefined,
  metadata: Record<string, unknown> | undefined,
): { phone?: string; metadata?: Record<string, unknown> } {
  // An explicit top-level phone always wins; nothing to lift if metadata carries no phone.
  if ((phone && phone.trim() !== "") || !metadata) return { phone, metadata }
  const raw = metadata.phone ?? metadata.phoneNumber ?? metadata.phone_number ?? metadata.tel
  if (typeof raw !== "string" || raw.trim() === "") return { phone, metadata }
  const restMetadata = { ...metadata }
  delete restMetadata.phone
  delete restMetadata.phoneNumber
  delete restMetadata.phone_number
  delete restMetadata.tel
  return {
    phone: raw.trim(),
    metadata: Object.keys(restMetadata).length > 0 ? restMetadata : undefined,
  }
}

/** The company and legal-record fields of a contacts_write, resolved for `updateContact`. */
async function contactCompanyAndBasis(
  params: ContactsWriteParams,
  ctx: ContactToolContext,
): Promise<
  | { fields: Parameters<typeof updateContact>[1]["updates"] }
  | { error: { code: string; message: string } }
> {
  const fields: Parameters<typeof updateContact>[1]["updates"] = {}
  if (params.companyId !== undefined) {
    if (params.companyId === null) {
      fields.companyId = null
    } else {
      const [company] = UUID_RE.test(params.companyId)
        ? await ctx.db
            .select({ id: companiesTable.id, name: companiesTable.name })
            .from(companiesTable)
            .where(
              and(eq(companiesTable.id, params.companyId), eq(companiesTable.orgId, ctx.orgId)),
            )
            .limit(1)
        : []
      if (!company) {
        return {
          error: {
            code: "NOT_FOUND",
            message: `Company not found: ${params.companyId}. Only pass an id you saw in a kernel__companies_search result.`,
          },
        }
      }
      fields.companyId = company.id
      // The person carries the company's name as their company text.
      fields.company = company.name
    }
  }
  if (params.lawfulBasis !== undefined) fields.lawfulBasis = params.lawfulBasis
  if (params.lawfulBasisSource !== undefined) fields.lawfulBasisSource = params.lawfulBasisSource
  if (params.isConsumer !== undefined) fields.isConsumer = params.isConsumer
  if (params.recipientCountry !== undefined) fields.recipientCountry = params.recipientCountry
  if (params.dataSource !== undefined) fields.dataSource = params.dataSource
  return { fields }
}

export async function handleContactsWrite(params: ContactsWriteParams, ctx: ContactToolContext) {
  const extra = await contactCompanyAndBasis(params, ctx)
  if ("error" in extra) return extra
  // BL-25: route a VAT the agent put in `metadata` onto the field of record `externalIds.vat_id`.
  const { externalIds, metadata: metadataAfterVat } = liftMisplacedVatId(
    params.externalIds,
    params.metadata,
  )
  // enrich-dealer-contact-from-website: route a phone the agent nested in `metadata` onto the
  // first-class `phone` column (the detail view renders it from there; metadata.phone leaves it NULL).
  const { phone, metadata } = liftMisplacedPhone(params.phone, metadataAfterVat)
  if (params.contactId) {
    // When the update sets an email, guard the (orgId, email) unique index up front (excluding THIS
    // contact) so a collision returns a clean EMAIL_IN_USE — mirroring the create path — instead of a
    // raw DB unique-constraint exception. NULL emails never collide (Postgres allows multiple NULLs).
    if (params.email) {
      const [clash] = extractRows<{ id: string }>(
        await ctx.db.execute(drizzleSql`
        SELECT id
        FROM ${tableRef("kernel", "contacts")}
        WHERE org_id = ${ctx.orgId}
          AND LOWER(email) = ${params.email.toLowerCase()}
          AND id <> ${params.contactId}
        LIMIT 1
      `),
      )
      if (clash) {
        return {
          error: {
            code: "EMAIL_IN_USE",
            message: "Email already in use",
            existingContactId: clash.id,
          },
        }
      }
    }
    const updated = await updateContact(ctx.db, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      contactId: params.contactId,
      updates: {
        name: params.name,
        // email IS persisted on update — omitting it here silently dropped the email an enrichment
        // passed (the record returned email=null despite a 2xx). See updateContact + the regression test.
        email: params.email,
        // phone is the metadata-lifted value so a number nested in metadata still lands in the column.
        phone,
        company: params.company,
        externalIds,
        metadata,
        tags: params.tags,
        ...extra.fields,
      },
    })
    if (!updated) return { error: { code: "NOT_FOUND", message: "Contact not found" } }
    return { contact: updated }
  }

  if (params.email) {
    const [existing] = extractRows<{ id: string }>(
      await ctx.db.execute(drizzleSql`
      SELECT id
      FROM ${tableRef("kernel", "contacts")}
      WHERE org_id = ${ctx.orgId} AND LOWER(email) = ${params.email.toLowerCase()}
      LIMIT 1
    `),
    )
    if (existing) {
      return {
        error: {
          code: "EMAIL_IN_USE",
          message: "Email already in use",
          existingContactId: existing.id,
        },
      }
    }
  }

  // An agent's new contact belongs to the person it acts for. Making it the
  // organisation's is a separate, gated decision (contacts_share).
  if (!UUID_RE.test(ctx.userId)) {
    return {
      error: {
        code: "NO_OWNER",
        message:
          "A new contact belongs to the person it is created for, and this run acts for no person.",
      },
    }
  }
  const { contact } = await resolveContact(
    ctx.db,
    ctx.orgId,
    ctx.userId,
    {
      email: params.email,
      name: params.name,
      // phone is the metadata-lifted value so a number nested in metadata still lands in the column.
      phone,
      company: params.company,
      externalId: externalIds,
      tags: params.tags,
      // Persist metadata (e.g. a captured postal address / source URL) on CREATE too — the create path
      // used to drop it, so an address supplied when first creating a contact was silently lost.
      metadata,
    },
    { audience: "owner", ownerUserId: ctx.userId },
  )
  if (contact && Object.keys(extra.fields).length > 0) {
    const withExtra = await updateContact(ctx.db, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      contactId: contact.id,
      updates: extra.fields,
    })
    return { contact: withExtra ?? contact }
  }
  return { contact }
}

/**
 * `contacts_find_duplicates` (BL-266) — server-side duplicate-CLUSTER detection. Scans the org's WHOLE
 * contact set (bounded) and returns candidate duplicate clusters with a confidence TIER, so the agent
 * proposes merges from a GROUNDED list instead of name-by-name guessing (which leads weak models to
 * fabricate "I scanned all 120 and found every duplicate"). RLS-scoped READ — stages nothing; the
 * contacts_merge it feeds stays GATED + irreversible.
 *
 * Confidence tiers in the result:
 *   • high — name agrees AND a corroborating signal (same normalized email / company / shared
 *     externalId), or a shared provider customer id on its own — SAFE to propose for merge.
 *   • needs_confirmation — a shared surname with a DIFFERENT given-name root, or a name variant with no
 *     corroboration — SURFACE for human confirmation, NEVER auto-merge (the near-dup traps land here).
 * `coveragePartial:true` means the scan hit its cap before the full list — report that, don't claim
 * completeness.
 */
export async function handleContactsFindDuplicates(
  params: { scanCap?: number; maxClusters?: number },
  ctx: ContactToolContext,
) {
  const result = await findDuplicateClusters(ctx.db, {
    orgId: ctx.orgId,
    scanCap: params.scanCap,
    maxClusters: params.maxClusters,
  })
  return {
    clusters: result.clusters,
    scannedCount: result.scannedCount,
    totalCount: result.totalCount,
    coveragePartial: result.coveragePartial,
    highConfidenceCount: result.highConfidenceCount,
    needsConfirmationCount: result.needsConfirmationCount,
  }
}

export async function handleContactsMerge(
  params: {
    sourceId: string
    targetId: string
    resolvedFields?: {
      name?: string
      email?: string
      phone?: string
      company?: string
      companyId?: string
      lawfulBasis?: string
    }
  },
  ctx: ContactToolContext,
) {
  // Shared with the stage-time preflight (contactsMergePreflight) so the two can never drift.
  const self = contactsMergeSelfRefusal(params)
  if (self) return { error: self }

  try {
    return await mergeContactsWithMailReferences(ctx.db, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      sourceId: params.sourceId,
      targetId: params.targetId,
      resolvedFields: params.resolvedFields,
    })
  } catch (err) {
    if (err instanceof HTTPException && err.status === 404) {
      return { error: { code: "NOT_FOUND", message: err.message } }
    }
    if (err instanceof HTTPException && err.status === 422) {
      return { error: { code: "INVALID_ARGUMENT", message: err.message } }
    }
    throw err
  }
}

export interface ContactsShareParams {
  contactId: string
  orgAccess: "none" | "viewer" | "editor"
  users?: Array<{ userId: string; role: "viewer" | "editor" }>
  roles?: Array<{ roleId: string; role: "viewer" | "editor" }>
}

/**
 * `contacts_share`: the explicit "add to organisation" / "share with" action
 * (GATED: a human approves it). Runs as the APPROVING human through their
 * RLS transaction, so the database's own rule decides: only the contact's
 * owner may change its sharing, and a contact the team uses cannot be taken
 * back (modules/contacts/sharing.ts).
 */
export async function handleContactsShare(params: ContactsShareParams, ctx: ContactToolContext) {
  if (!UUID_RE.test(ctx.userId)) {
    return { error: { code: "NO_OWNER", message: "Only a person can share a contact" } }
  }
  try {
    const sharing = await setContactSharing(ctx.db, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      contactId: params.contactId,
      sharing: { orgAccess: params.orgAccess, users: params.users, roles: params.roles },
    })
    return {
      contactId: params.contactId,
      orgAccess: sharing.orgAccess,
      users: sharing.users.length,
      roles: sharing.roles.length,
      dimensions: sharing.dimensions.length,
    }
  } catch (err) {
    if (err instanceof HTTPException) {
      const code =
        err.status === 404
          ? "NOT_FOUND"
          : err.status === 403
            ? "FORBIDDEN"
            : err.status === 409
              ? "CONFLICT"
              : err.status === 422
                ? "INVALID_ARGUMENT"
                : null
      if (code) return { error: { code, message: err.message } }
    }
    throw err
  }
}

/**
 * STAGE-TIME preflight for the gated `contacts_share`: a contact the requester
 * cannot see reads as missing (no oracle for ids), and one they cannot manage
 * is refused before a human is asked. The same rule as
 * `kernel.can_manage_contact_sharing`, evaluated for the requester.
 */
export async function contactsSharePreflight(
  params: ContactsShareParams,
  ctx: ContactToolContext,
): Promise<unknown> {
  if (!UUID_RE.test(ctx.userId)) {
    return { error: { code: "NO_OWNER", message: "Only a person can share a contact" } }
  }
  // Asked of the database under the requester's own RLS: a contact they cannot
  // see reads as missing (no oracle for ids), and kernel.can_manage_sharing
  // is the one rule for who may change it.
  try {
    const sharing = await getContactSharing(ctx.db, {
      orgId: ctx.orgId,
      contactId: params.contactId,
    })
    if (!sharing.canManage) {
      return {
        error: {
          code: "FORBIDDEN",
          message:
            "Only the contact's owner (or, for a contact nobody owns, an admin) can change who it is shared with. Ask them to share it.",
        },
      }
    }
  } catch (err) {
    if (err instanceof HTTPException && err.status === 404) {
      return {
        error: {
          code: "NOT_FOUND",
          message: `Contact not found: ${params.contactId}. Only pass ids you actually saw in a kernel__contacts_search or kernel__contacts_read result.`,
        },
      }
    }
    throw err
  }
  return { ok: true }
}

/** kernel:data_subject_export: one person's full personal-data bundle, as a file. */
export async function summarizeDataSubjectExport(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = (params ?? {}) as { contactId?: string; userId?: string; shopifyOrders?: unknown[] }
  if (typeof p.userId === "string" && p.userId) {
    const memberId = p.userId === "me" ? ctx.userId : p.userId
    let member = "(unknown member)"
    if (UUID_RE.test(memberId)) {
      const [u] = await ctx.tx
        .select({ name: usersTable.name, email: usersTable.email })
        .from(usersTable)
        .where(and(eq(usersTable.id, memberId), eq(usersTable.orgId, ctx.orgId)))
        .limit(1)
      if (u) member = `${u.name} <${u.email}>`
    }
    return {
      kind: "data_subject_export",
      title: `Export all personal data of ${memberId === ctx.userId ? "yourself" : member}`,
      lines: [
        "One downloadable file with their profile, messages, files, approvals, routines, audit entries, connected accounts and agent memory. No tokens or passwords.",
      ],
    }
  }
  let label = "(unknown contact)"
  if (typeof p.contactId === "string" && p.contactId) {
    const [c] = await ctx.tx
      .select({ name: contactsTable.name, email: contactsTable.email })
      .from(contactsTable)
      .where(and(eq(contactsTable.id, p.contactId), eq(contactsTable.orgId, ctx.orgId)))
      .limit(1)
    if (c) label = c.email ? `${c.name ?? "(unnamed)"} <${c.email}>` : (c.name ?? "(unnamed)")
  }
  const orders = Array.isArray(p.shopifyOrders) ? p.shopifyOrders.length : 0
  return {
    kind: "data_subject_export",
    title: `Export all personal data of ${label}`,
    lines: [
      "One downloadable file with their contact record, tickets and invoices.",
      ...(orders > 0 ? [`Includes ${orders} Shopify order${orders === 1 ? "" : "s"}`] : []),
    ],
  }
}

export async function summarizeContactsShare(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = params as Partial<ContactsShareParams>
  let label = p.contactId ?? "(unknown contact)"
  if (p.contactId) {
    const [c] = await ctx.tx
      .select({ name: contactsTable.name, email: contactsTable.email })
      .from(contactsTable)
      .where(and(eq(contactsTable.id, p.contactId), eq(contactsTable.orgId, ctx.orgId)))
      .limit(1)
    if (c) label = c.email ? `${c.name ?? "(unnamed)"} <${c.email}>` : (c.name ?? "(unnamed)")
  }
  const audience =
    p.orgAccess === "editor"
      ? "everyone in the organisation (can edit)"
      : p.orgAccess === "viewer"
        ? "everyone in the organisation (read only)"
        : "no longer the whole organisation"
  const lines = [`Contact: ${label}`, `Shared with: ${audience}`]
  if (p.users) lines.push(`People: ${p.users.length} (replaces the current list)`)
  if (p.roles) lines.push(`Roles: ${p.roles.length} (replaces the current list)`)
  return {
    kind: "contacts_share",
    title:
      p.orgAccess === "none" ? `Stop sharing ${label}` : `Share ${label} with the organisation`,
    lines,
  }
}

/**
 * Approval summary for the GATED `contacts_merge`. A merge is IRREVERSIBLE — the
 * source record is permanently deleted and all of its mail conversations are
 * reassigned to the survivor — so the human approver must see exactly which
 * record survives, which is deleted, and which field values win, before approving.
 * Reads both contacts (under the caller's RLS) to render real names/emails rather
 * than raw uuids; falls back to the id if a side cannot be read.
 */
export async function summarizeContactsMerge(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = params as {
    sourceId?: string
    targetId?: string
    resolvedFields?: { name?: string; email?: string; phone?: string; company?: string }
  }
  const label = async (id?: string): Promise<string> => {
    if (!id) return "(unknown contact)"
    const [c] = await ctx.tx
      .select({ name: contactsTable.name, email: contactsTable.email })
      .from(contactsTable)
      .where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, ctx.orgId)))
      .limit(1)
    if (!c) return id
    const name = c.name ?? "(unnamed)"
    return c.email ? `${name} <${c.email}>` : name
  }
  const survivor = await label(p.targetId)
  const deleted = await label(p.sourceId)
  const lines = [
    `Survivor (kept): ${survivor}`,
    `Deleted (merged away): ${deleted}`,
    "This is IRREVERSIBLE: the deleted record is permanently removed and all of its mail conversations are reassigned to the survivor.",
  ]
  const rf = p.resolvedFields
  if (rf && (rf.name || rf.email || rf.phone || rf.company)) {
    const parts: string[] = []
    if (rf.name) parts.push(`name="${rf.name}"`)
    if (rf.email) parts.push(`email="${rf.email}"`)
    if (rf.phone) parts.push(`phone="${rf.phone}"`)
    if (rf.company) parts.push(`company="${rf.company}"`)
    lines.push(`Resolved field values on the survivor: ${parts.join(", ")}.`)
  }
  return {
    kind: "contacts_merge",
    title: `Merge contacts → keep ${survivor}, delete ${deleted}`,
    lines,
  }
}

/**
 * `contacts_export` — materialize the RLS-visible contacts (optionally scoped to
 * a stored segment or a single tag) into a CSV `kernel.files` artifact. GATED on
 * `kernel:contacts:export` (exporting PII is a privileged boundary). Returns the
 * file id the agent can attach or hand to the user.
 */
export async function handleContactsExport(
  params: { format?: "csv"; segmentId?: string; tag?: string },
  ctx: ContactToolContext,
) {
  try {
    const { fileId } = await exportContactsToFile(ctx.db, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      scopes: ctx.scopes ?? [],
      format: "csv",
      segmentId: params.segmentId,
      tag: params.tag,
    })
    return { fileId }
  } catch (err) {
    if (err instanceof HTTPException && err.status === 403) {
      return { error: { code: "FORBIDDEN", message: err.message } }
    }
    if (err instanceof HTTPException && err.status === 404) {
      return { error: { code: "NOT_FOUND", message: err.message } }
    }
    if (err instanceof HTTPException && err.status === 413) {
      return { error: { code: "QUOTA_EXCEEDED", message: err.message } }
    }
    throw err
  }
}

// --- Stage-time preflights for the gated contact tools ----------------------
//
// WHY: a gated call must NOT be parked for a human when the data it needs is
// missing or invalid. Without these, the approver approves an irreversible merge
// and gets back NOT_FOUND for an id the agent half-remembered, or approves a PII
// export that cannot be written because the org is already over its storage
// quota. Both are knowable at staging, so the agent is corrected in-loop and no
// approval is created. Every probe here is read-only.

/** Shared self-merge guard for contacts_merge: called by BOTH the preflight and
 *  {@link handleContactsMerge}, so the two can never drift. */
export function contactsMergeSelfRefusal(params: {
  sourceId: string
  targetId: string
}): { code: string; message: string } | null {
  if (params.sourceId === params.targetId) {
    return { code: "INVALID_ARGUMENT", message: "Cannot merge a contact with itself" }
  }
  return null
}

/** STAGE-TIME preflight for the gated `contacts_merge`. Refuses a self-merge and an id that
 *  names no contact in the org. The existence probe is privileged and existence-only: a
 *  preflight must never refuse on VISIBILITY, which is the approver's RLS decision at
 *  execution and stays there. */
export async function contactsMergePreflight(
  params: { sourceId: string; targetId: string },
  ctx: {
    orgId: string
    userId?: string
    roles?: string[]
    dimensionGrants?: Record<string, string[]>
  },
): Promise<unknown> {
  const self = contactsMergeSelfRefusal(params)
  if (self) return { error: self }
  const missing = await contactIdsMissingForRequester(ctx, [params.sourceId, params.targetId])
  if (missing.length > 0) {
    return {
      error: {
        code: "NOT_FOUND",
        message: `Contact not found: ${missing.join(", ")}. Only pass ids you actually saw in a kernel__contacts_search or kernel__contacts_read result.`,
      },
    }
  }
  return { ok: true }
}

interface PreflightRequester {
  orgId: string
  userId?: string
  roles?: string[]
  dimensionGrants?: Record<string, string[]>
}

/**
 * The ids among `ids` that name no contact the requester may know: an
 * org-visible contact, one they own, or one shared with them count. Someone
 * else's restricted contact reads as missing, exactly as it does through
 * contacts_read, so a preflight is no oracle for ids the requester cannot see.
 * Privileged and existence-only: visibility at execution stays the approver's
 * RLS decision.
 */
async function contactIdsMissingForRequester(
  ctx: PreflightRequester,
  ids: string[],
): Promise<string[]> {
  return withPrivilegedDb(ctx.orgId, "contacts-preflight", async (tx) => {
    const found = await tx
      .select({
        id: contactsTable.id,
        orgAccess: contactsTable.orgAccess,
        ownerUserId: contactsTable.ownerUserId,
      })
      .from(contactsTable)
      .where(and(eq(contactsTable.orgId, ctx.orgId), inArray(contactsTable.id, ids)))
    const visible = new Set<string>()
    for (const row of found) {
      if (row.orgAccess !== "none" || (ctx.userId && row.ownerUserId === ctx.userId)) {
        visible.add(row.id)
      } else if (
        ctx.userId &&
        (await actorGrantRole(tx, "kernel.contact", row.id, {
          userId: ctx.userId,
          roles: ctx.roles,
          dimensionGrants: ctx.dimensionGrants,
        }))
      ) {
        visible.add(row.id)
      }
    }
    return ids.filter((id) => !visible.has(id))
  })
}

/** STAGE-TIME preflight for the gated `contacts_export`. Refuses a `segmentId` that names no
 *  segment in the org, and an export into an org whose storage quota is ALREADY full: the
 *  quota test is monotonic in the CSV's size, so an org that is over quota with zero added
 *  bytes can never fit the export, whatever it turns out to weigh. The exact byte-size test
 *  stays at execution, where the CSV actually exists. */
export async function contactsExportPreflight(
  params: { segmentId?: string; tag?: string },
  ctx: { orgId: string },
): Promise<unknown> {
  if (params.segmentId) {
    const exists = await withPrivilegedDb(ctx.orgId, "contacts-export-preflight", async (tx) => {
      const [s] = await tx
        .select({ id: contactSegments.id })
        .from(contactSegments)
        .where(and(eq(contactSegments.id, params.segmentId!), eq(contactSegments.orgId, ctx.orgId)))
        .limit(1)
      return Boolean(s)
    })
    if (!exists) return { error: { code: "NOT_FOUND", message: "Segment not found" } }
  }
  const full = await withPrivilegedDb(ctx.orgId, "contacts-export-quota-preflight", async (tx) => {
    const settings = await loadOrgSettings(tx, ctx.orgId)
    return wouldExceedOrgQuota(tx, ctx.orgId, settings, 0)
  })
  if (full) return { error: { code: "QUOTA_EXCEEDED", message: "Org storage quota exceeded" } }
  return { ok: true }
}

// --- Contact groups (S15): named groups with hand-picked members -------------
//
// Every call runs under the caller's RLS: a member is listed, counted, added or
// removed only when its contact is visible to them, so a routine sees exactly
// what its owner sees. Ids the caller cannot see come back in `notFound`.

/** The tool error code of each refusal the groups service throws. */
const GROUP_ERROR_CODES: Readonly<Record<number, string>> = {
  400: "INVALID_ARGUMENT",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "INVALID_ARGUMENT",
}

/** Run a groups call, answering its refusals as a tool error envelope. */
async function groupCall<T>(
  fn: () => Promise<T>,
): Promise<T | { error: { code: string; message: string } }> {
  try {
    return await fn()
  } catch (err) {
    const code = err instanceof HTTPException ? GROUP_ERROR_CODES[err.status] : undefined
    if (code) return { error: { code, message: (err as HTTPException).message } }
    throw err
  }
}

function groupNotFound(groupId: string) {
  return {
    error: {
      code: "NOT_FOUND",
      message: `Group not found: ${groupId}. Only pass a groupId you saw in a kernel__contacts_groups_list result.`,
    },
  }
}

export async function handleContactsGroupsList(_params: unknown, ctx: ContactToolContext) {
  const groups = await listGroups(ctx.db, { orgId: ctx.orgId })
  return {
    groups: groups.map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount })),
    totalCount: groups.length,
  }
}

export async function handleContactsGroupCreate(params: { name: string }, ctx: ContactToolContext) {
  return groupCall(async () => {
    const group = await createGroup(ctx.db, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      name: params.name,
    })
    return { id: group.id, name: group.name, memberCount: 0 }
  })
}

export async function handleContactsGroupRename(
  params: { groupId: string; name: string },
  ctx: ContactToolContext,
) {
  return groupCall(async () => {
    const group = await renameGroup(ctx.db, {
      orgId: ctx.orgId,
      groupId: params.groupId,
      name: params.name,
    })
    return { id: group.id, name: group.name, memberCount: group.memberCount }
  })
}

export async function handleContactsGroupDelete(
  params: { groupId: string },
  ctx: ContactToolContext,
) {
  const deleted = await deleteGroup(ctx.db, { orgId: ctx.orgId, groupId: params.groupId })
  if (!deleted) return groupNotFound(params.groupId)
  return { deleted: true, id: deleted.id, name: deleted.name }
}

export async function handleContactsGroupAdd(
  params: { groupId: string; contactIds: string[] },
  ctx: ContactToolContext,
) {
  return groupCall(async () => {
    const r = await addGroupMembers(ctx.db, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      groupId: params.groupId,
      contactIds: params.contactIds,
    })
    return {
      groupId: r.groupId,
      groupName: r.groupName,
      added: r.changed,
      alreadyMembers: r.unchanged,
      notFound: r.notFound,
    }
  })
}

export async function handleContactsGroupRemove(
  params: { groupId: string; contactIds: string[] },
  ctx: ContactToolContext,
) {
  return groupCall(async () => {
    const r = await removeGroupMembers(ctx.db, {
      orgId: ctx.orgId,
      groupId: params.groupId,
      contactIds: params.contactIds,
    })
    return {
      groupId: r.groupId,
      groupName: r.groupName,
      removed: r.changed,
      notMembers: r.unchanged,
      notFound: r.notFound,
    }
  })
}

export async function handleContactsGroupMembers(
  params: { groupId: string; limit?: number; cursor?: string },
  ctx: ContactToolContext,
) {
  return groupCall(async () => {
    const limit = Math.min(params.limit ?? 50, 200)
    const page = params.cursor ? Math.max(1, Number(params.cursor) || 1) : 1
    const { group, rows, total } = await listGroupMembers(ctx.db, {
      orgId: ctx.orgId,
      groupId: params.groupId,
      page,
      limit,
    })
    return {
      group: { id: group.id, name: group.name },
      items: rows.map((c) => ({
        id: c.id,
        name: c.name,
        primaryEmail: c.email,
        company: c.company,
        phone: c.phone ?? null,
        tags: c.tags ?? [],
      })),
      totalCount: total,
      nextCursor: page * limit < total ? String(page + 1) : undefined,
    }
  })
}

/** STAGE-TIME preflight for the gated `contacts_group_delete`: a group that does
 *  not exist is refused before a human is asked to approve deleting it. */
export async function contactsGroupDeletePreflight(
  params: { groupId: string },
  ctx: ContactToolContext,
): Promise<unknown> {
  const group = await getGroup(ctx.db, { orgId: ctx.orgId, groupId: params.groupId })
  if (!group) return groupNotFound(params.groupId)
  return { ok: true }
}

export async function summarizeContactsGroupDelete(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = params as { groupId?: string }
  const group = p.groupId ? await getGroup(ctx.tx, { orgId: ctx.orgId, groupId: p.groupId }) : null
  const label = group ? `"${group.name}"` : (p.groupId ?? "(unknown group)")
  const lines = [`Group: ${label}`]
  if (group) lines.push(`Members: ${group.memberCount} (the contacts themselves are kept)`)
  return { kind: "contacts_group_delete", title: `Delete the contact group ${label}`, lines }
}

// --- Contact writes (gated for agents) --------------------------------------

export interface ContactsWriteParams {
  contactId?: string
  name?: string
  email?: string
  phone?: string
  company?: string
  externalIds?: Record<string, string>
  metadata?: Record<string, unknown>
  tags?: string[]
  companyId?: string | null
  lawfulBasis?: "consent" | "customer" | "professional_interest" | "generic_address"
  lawfulBasisSource?: string
  isConsumer?: boolean
  recipientCountry?: string
  dataSource?: "direct" | "third_party" | "enrichment"
}

function summaryValue(v: unknown): string {
  if (typeof v === "string") return v
  if (v === null || v === undefined) return "(empty)"
  return JSON.stringify(v)
}

/** Each field the write sets, as "field → new value", after the same lifts the
 *  handler applies (a VAT id or a phone nested in metadata lands on its field). */
export function contactsWriteChanges(params: ContactsWriteParams): string[] {
  const { externalIds, metadata: afterVat } = liftMisplacedVatId(
    params.externalIds,
    params.metadata,
  )
  const { phone, metadata } = liftMisplacedPhone(params.phone, afterVat)
  const lines: string[] = []
  if (params.name !== undefined) lines.push(`Name → ${params.name}`)
  if (params.email !== undefined) lines.push(`Email → ${params.email}`)
  if (phone !== undefined) lines.push(`Phone → ${phone}`)
  if (params.company !== undefined) lines.push(`Company → ${params.company}`)
  if (params.tags !== undefined) {
    lines.push(`Tags → ${params.tags.length > 0 ? params.tags.join(", ") : "(none)"}`)
  }
  if (params.companyId !== undefined) lines.push(`Company id → ${params.companyId ?? "(none)"}`)
  if (params.lawfulBasis !== undefined) {
    lines.push(
      `Lawful basis → ${params.lawfulBasis}${params.lawfulBasisSource ? ` (${params.lawfulBasisSource})` : ""}`,
    )
  } else if (params.lawfulBasisSource !== undefined) {
    lines.push(`Lawful basis source → ${params.lawfulBasisSource}`)
  }
  if (params.isConsumer !== undefined) lines.push(`Consumer → ${params.isConsumer ? "yes" : "no"}`)
  if (params.recipientCountry !== undefined) lines.push(`Country → ${params.recipientCountry}`)
  if (params.dataSource !== undefined) lines.push(`Data source → ${params.dataSource}`)
  for (const [k, v] of Object.entries(externalIds ?? {})) lines.push(`${k} → ${v}`)
  for (const [k, v] of Object.entries(metadata ?? {})) lines.push(`${k} → ${summaryValue(v)}`)
  return lines
}

/** The approval card of `contacts_write`: whose record, and each field with its new value. */
export async function summarizeContactsWrite(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = (params ?? {}) as ContactsWriteParams
  const changes = contactsWriteChanges(p)
  // The card holds 8 lines: past that, the last one says how many more the payload carries.
  const lines =
    changes.length === 0
      ? ["(no field to change)"]
      : changes.length > 8
        ? [...changes.slice(0, 7), `and ${changes.length - 7} more fields`]
        : changes
  if (!p.contactId) {
    const label = p.name ?? p.email ?? p.company ?? "(unnamed)"
    return {
      kind: "contacts_write",
      title: `Create the contact ${label}`,
      subtitle: "In Liaison's contacts, yours until you share it",
      lines,
    }
  }
  let label = p.contactId
  if (UUID_RE.test(p.contactId)) {
    const [c] = await ctx.tx
      .select({ name: contactsTable.name, email: contactsTable.email })
      .from(contactsTable)
      .where(and(eq(contactsTable.id, p.contactId), eq(contactsTable.orgId, ctx.orgId)))
      .limit(1)
    if (c) label = c.email ? `${c.name ?? "(unnamed)"} <${c.email}>` : (c.name ?? label)
  }
  return {
    kind: "contacts_write",
    title: `Edit the contact ${label}`,
    subtitle: "In Liaison's contacts",
    lines,
  }
}

/** STAGE-TIME preflight for the gated `contacts_write`: a write that changes
 *  nothing, an unknown contact, or an email another contact already has is
 *  refused before an approval is parked. */
export async function contactsWritePreflight(
  params: ContactsWriteParams,
  ctx: PreflightRequester,
): Promise<unknown> {
  if (contactsWriteChanges(params).length === 0) {
    return {
      error: {
        code: "INVALID_ARGUMENT",
        message: "Nothing to save: pass at least one field to set on the contact.",
      },
    }
  }
  if (params.contactId) {
    const missing = await contactIdsMissingForRequester(ctx, [params.contactId])
    if (missing.length > 0) {
      return {
        error: {
          code: "NOT_FOUND",
          message: `Contact not found: ${params.contactId}. Only pass an id you actually saw in a kernel__contacts_search or kernel__contacts_read result; omit contactId to create a contact.`,
        },
      }
    }
  }
  if (params.email) {
    const email = params.email.toLowerCase()
    const contactId = params.contactId
    const [clash] = await withPrivilegedDb(ctx.orgId, "contacts-write-preflight", (tx) =>
      tx
        .select({ id: contactsTable.id })
        .from(contactsTable)
        .where(
          and(
            eq(contactsTable.orgId, ctx.orgId),
            drizzleSql`LOWER(${contactsTable.email}) = ${email}`,
            ...(contactId ? [drizzleSql`${contactsTable.id} <> ${contactId}`] : []),
          ),
        )
        .limit(1),
    )
    // Only a contact the requester may know is named: a preflight is no oracle for the rest.
    if (clash && (await contactIdsMissingForRequester(ctx, [clash.id])).length === 0) {
      return {
        error: {
          code: "EMAIL_IN_USE",
          message:
            "Email already in use by another contact: update that contact instead, or merge the two with kernel__contacts_merge.",
          existingContactId: clash.id,
        },
      }
    }
  }
  return { ok: true }
}

// ============================================================================
// Address book (modules/contacts/addresses.ts)
// ============================================================================
//
// Three tools. `contacts_addresses_list` reads a contact's addresses with their
// verification: the provider-neutral API a shipping or billing app reads.
// `contacts_address_upsert` adds or changes one, gated like contacts_write, and
// always leaves the address NOT verified. `contacts_address_verify` records that
// a PERSON checked it against a source: gated and noAutoApprove, so no policy
// and no app capability answers it, only a person's approval (or their own
// direct call), and the verifier recorded is that person.

/** A tool call's context, with who acts and who approved (execute-tool sets both). */
interface AddressToolContext extends ContactToolContext {
  actorType?: "user" | "agent" | "mcp"
  approverUserId?: string | null
}

export type AddressesListParams = {
  contactId: string
  role?: ContactAddressRole
  includeArchived?: boolean
}

export type AddressUpsertParams = AddressFields & { contactId: string; addressId?: string }

export type AddressVerifyParams = VerifyAddressParams & { contactId: string; addressId: string }

const SOURCE_LABELS: Record<ContactAddressSource, string> = {
  purchase_order: "a purchase order",
  email: "an email",
  phone_call: "a phone call",
  other: "another source",
}

/** An address service error as a tool error the model can act on. */
function addressToolError(
  err: unknown,
): { error: { code: string; message: string; status: number } } | null {
  if (!(err instanceof HTTPException)) return null
  const code =
    err.status === 404
      ? "NOT_FOUND"
      : err.status === 403
        ? "FORBIDDEN"
        : err.status === 409
          ? "CONFLICT"
          : err.status === 422 || err.status === 400
            ? "INVALID_ARGUMENT"
            : null
  // The status travels with the error, so a refusal reads as the caller's mistake (4xx),
  // never as a server fault.
  return code ? { error: { code, message: err.message, status: err.status } } : null
}

function addressView(a: ContactAddress) {
  return {
    id: a.id,
    role: a.role,
    label: a.label,
    name: a.name,
    company: a.company,
    street1: a.street1,
    street2: a.street2,
    city: a.city,
    postalCode: a.postalCode,
    region: a.region,
    countryIso2: a.countryIso2,
    phone: a.phone,
    email: a.email,
    origin: a.origin,
    verified: a.verified,
    verifiedAt: a.verifiedAt,
    verifiedBy: a.verifiedBy,
    verifiedByName: a.verifiedByName,
    verificationSource: a.source,
    verificationNote: a.sourceNote,
    verificationFileId: a.sourceFileId,
    stale: a.staleAt !== null,
    staleAt: a.staleAt,
    archived: a.archivedAt !== null,
  }
}

export async function handleContactsAddressesList(
  params: AddressesListParams,
  ctx: ContactToolContext,
) {
  try {
    const rows = await listAddresses(ctx.db, {
      orgId: ctx.orgId,
      contactId: params.contactId,
      role: params.role,
      includeArchived: params.includeArchived,
    })
    return { contactId: params.contactId, addresses: rows.map(addressView) }
  } catch (err) {
    const mapped = addressToolError(err)
    if (mapped) return mapped
    throw err
  }
}

function upsertFields(params: AddressUpsertParams): AddressFields {
  const { contactId: _c, addressId: _a, ...fields } = params
  return fields
}

/** `contacts_address_upsert`: add (no addressId) or change an address. Never verifies. */
export async function handleContactsAddressUpsert(
  params: AddressUpsertParams,
  ctx: ContactToolContext,
) {
  try {
    if (params.addressId) {
      const { address, changed, verificationCleared } = await updateAddress(ctx.db, {
        orgId: ctx.orgId,
        contactId: params.contactId,
        addressId: params.addressId,
        patch: upsertFields(params),
        // An agent's edit is never a verified one, whatever field it changed.
        clearVerification: true,
      })
      return { address: addressView(address), created: false, changed, verificationCleared }
    }
    const { address, created } = await addAddress(ctx.db, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      contactId: params.contactId,
      fields: upsertFields(params),
    })
    return { address: addressView(address), created, changed: created }
  } catch (err) {
    const mapped = addressToolError(err)
    if (mapped) return mapped
    throw err
  }
}

/** STAGE-TIME preflight for the gated upsert: the contact (and address) must exist for the requester. */
export async function contactsAddressUpsertPreflight(
  params: AddressUpsertParams,
  ctx: ContactToolContext,
): Promise<unknown> {
  try {
    if (params.addressId) {
      const current = await getAddress(ctx.db, {
        orgId: ctx.orgId,
        contactId: params.contactId,
        addressId: params.addressId,
      })
      if (current.archivedAt) {
        return { error: { code: "CONFLICT", message: "This address is archived" } }
      }
    } else {
      await listAddresses(ctx.db, { orgId: ctx.orgId, contactId: params.contactId })
    }
  } catch (err) {
    const mapped = addressToolError(err)
    if (mapped) {
      if (mapped.error.code === "NOT_FOUND") {
        mapped.error.message = `${mapped.error.message}. Only pass ids you saw in a kernel__contacts_search, kernel__contacts_read or kernel__contacts_addresses_list result.`
      }
      return mapped
    }
    throw err
  }
  return { ok: true }
}

/**
 * `contacts_address_verify`: record that a PERSON checked the address. The
 * verifier is the person who approved the card, or the person whose own direct
 * call this is; an agent, an app or a machine path is never one.
 */
export async function handleContactsAddressVerify(
  params: AddressVerifyParams,
  ctx: AddressToolContext,
) {
  const verifier =
    ctx.approverUserId && UUID_RE.test(ctx.approverUserId)
      ? ctx.approverUserId
      : ctx.actorType === "user" && UUID_RE.test(ctx.userId)
        ? ctx.userId
        : null
  if (!verifier) {
    return {
      error: {
        code: "FORBIDDEN",
        message: "Only a person can verify an address: it needs a person's approval",
        status: 403,
      },
    }
  }
  try {
    const address = await verifyAddress(ctx.db, {
      orgId: ctx.orgId,
      contactId: params.contactId,
      addressId: params.addressId,
      verifierUserId: verifier,
      verification: { source: params.source, note: params.note, fileId: params.fileId },
    })
    return { address: addressView(address) }
  } catch (err) {
    const mapped = addressToolError(err)
    if (mapped) return mapped
    throw err
  }
}

/**
 * STAGE-TIME preflight for verify: the address exists and is not archived, the
 * contact is editable, and a source file is one the REQUESTER can read, so a
 * card never points at a file the asker could not open.
 */
export async function contactsAddressVerifyPreflight(
  params: AddressVerifyParams,
  ctx: ContactToolContext,
): Promise<unknown> {
  try {
    await assertVerifiable(ctx.db, {
      orgId: ctx.orgId,
      contactId: params.contactId,
      addressId: params.addressId,
      fileId: params.fileId,
    })
  } catch (err) {
    const mapped = addressToolError(err)
    if (mapped) return mapped
    throw err
  }
  return { ok: true }
}

async function addressContactLabel(
  tx: RlsClient,
  orgId: string,
  contactId: string | undefined,
): Promise<string> {
  if (!contactId) return "(unknown contact)"
  const [c] = await tx
    .select({ name: contactsTable.name, email: contactsTable.email })
    .from(contactsTable)
    .where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, orgId)))
    .limit(1)
  if (!c) return contactId
  const name = c.name ?? "(unnamed)"
  return c.email ? `${name} <${c.email}>` : name
}

async function addressOrNull(
  tx: RlsClient,
  orgId: string,
  contactId: string | undefined,
  addressId: string | undefined,
): Promise<ContactAddress | null> {
  if (!contactId || !addressId) return null
  try {
    return await getAddress(tx, { orgId, contactId, addressId })
  } catch (err) {
    if (err instanceof HTTPException) return null
    throw err
  }
}

export async function summarizeContactsAddressUpsert(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = (params ?? {}) as Partial<AddressUpsertParams>
  const label = await addressContactLabel(ctx.tx, ctx.orgId, p.contactId)
  const current = await addressOrNull(ctx.tx, ctx.orgId, p.contactId, p.addressId)
  const merged = { ...(current ?? {}), ...p }
  const lines = [`Contact: ${label}`]
  if (current) lines.push(`Now: ${formatAddressLine(current) || "(empty)"}`)
  lines.push(`${current ? "Becomes" : "Address"}: ${formatAddressLine(merged) || "(empty)"}`)
  lines.push(`Role: ${merged.role ?? "delivery"}`)
  if (merged.phone) lines.push(`Phone: ${merged.phone}`)
  if (merged.email) lines.push(`Email: ${merged.email}`)
  lines.push(
    current?.verified
      ? "This address is verified: saving the change makes it NOT verified again."
      : "Saved as NOT verified: only a person can verify an address.",
  )
  return {
    kind: "contacts_address_upsert",
    title: current ? `Change an address of ${label}` : `Add an address to ${label}`,
    lines,
    ...(p.contactId
      ? {
          links: [
            { label: "Open contact", app: "kernel", entityType: "contact", entityId: p.contactId },
          ],
        }
      : {}),
  }
}

/**
 * The verify card: the FULL address as stored, what it was checked against,
 * the note, and a link to the source file, so the person approving sees what
 * they are vouching for. Their approval is the verification.
 */
export async function summarizeContactsAddressVerify(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = (params ?? {}) as Partial<AddressVerifyParams>
  const label = await addressContactLabel(ctx.tx, ctx.orgId, p.contactId)
  const address = await addressOrNull(ctx.tx, ctx.orgId, p.contactId, p.addressId)
  const file = p.fileId ? await readableFile(ctx.tx, ctx.orgId, p.fileId) : null
  const source = p.source && p.source in SOURCE_LABELS ? SOURCE_LABELS[p.source] : "(no source)"
  const lines = [
    `Address: ${address ? formatAddressLine(address) || "(empty)" : (p.addressId ?? "(unknown address)")}`,
  ]
  if (address) {
    lines.push(`Role: ${address.role}`)
    if (address.phone || address.email) {
      lines.push(`Contact details: ${[address.phone, address.email].filter(Boolean).join(", ")}`)
    }
  }
  lines.push(`Checked against: ${source}`)
  lines.push(`Note: ${p.note?.trim() ? p.note.trim() : "(none)"}`)
  lines.push(
    p.fileId ? `Source file: ${file?.filename ?? p.fileId}` : "Source file: (none attached)",
  )
  lines.push("Approving records YOU as the person who checked this address against that source.")
  const links: ApprovalSummary["links"] = []
  if (p.fileId) {
    links.push({ label: "Open source file", app: "kernel", entityType: "file", entityId: p.fileId })
  }
  if (p.contactId) {
    links.push({
      label: "Open contact",
      app: "kernel",
      entityType: "contact",
      entityId: p.contactId,
    })
  }
  return {
    kind: "contacts_address_verify",
    title: `Mark an address of ${label} as verified`,
    lines,
    links,
  }
}
