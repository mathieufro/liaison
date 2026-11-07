// SPDX-License-Identifier: FSL-1.1-ALv2
import { csvCell as exportCsvCell } from "@liaison/shared"
import { and, desc, sql as drizzleSql, eq, or } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { PrivilegedDb, RlsClient, RlsTx } from "~/db"
import { extractRows } from "~/db"
import { privilegedFrom, withElevatableRlsFrom, withPrivilegedDb } from "~/db/privileged"
import {
  contactAddresses,
  contactGroupMembers,
  contactSegments,
  contacts,
  files,
} from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { putObject } from "~/infra/storage/object-storage"
import { nextHandle } from "~/lib/handle"
import { contactsLogger as log } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { UUID_RE } from "~/lib/uuid"
import { deleteContactDiscussions, mergeContactDiscussion } from "~/modules/contacts/discussion"
import { memberOfGroupCondition } from "~/modules/contacts/groups"
import { runAfterContactMergeFailpoint } from "~/modules/contacts/merge-failpoint"
import { buildStorageKey, loadOrgSettings, wouldExceedOrgQuota } from "~/modules/files/service"
import { asAdmin, canManageSharing, recomputeSearchAcl } from "~/modules/sharing/service"

// Local-part heuristic for noreply / notification / automated senders.
// Used to derive `isAutomated` and to filter the default contact list to humans.
const AUTOMATED_EMAIL_PATTERN =
  "^(no[-_.]?reply|do[-_.]?not[-_.]?reply|noreply|notif|notification|notifications|automated|automation|alerts?|mailer[-_.]?daemon|postmaster|bounce|news|marketing|hello|info|support|admin|root|system|service|account|billing|receipts?|invoices?|orders?|webmaster|abuse|security)([-_.]|@|\\d)"

interface ResolveContactParams {
  email?: string
  name?: string
  phone?: string
  company?: string
  externalId?: Record<string, string>
  tags?: string[]
  // Free-form structured metadata (e.g. a captured postal address / source URL). The CREATE path
  // historically dropped this — only the UPDATE path persisted it — so a contact created WITH a
  // metadata.address (the build-dealer-records-from-research scenario) came back metadata:null and the
  // address was silently lost. It must round-trip on create exactly as it does on update.
  metadata?: Record<string, unknown>
}

// Build the metadata SET expression for an upsert conflict: when the resolve carries metadata, MERGE
// it onto the existing jsonb (incoming keys win), mirroring the externalIds union semantics; with no
// incoming metadata, leave the row's metadata untouched. A null existing metadata is coalesced to {}.
function mergeMetadataExpr(metadata?: Record<string, unknown>) {
  if (!metadata || Object.keys(metadata).length === 0) return drizzleSql`${contacts.metadata}`
  return drizzleSql`COALESCE(${contacts.metadata}, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb`
}

/**
 * Who a contact is FOR, decided by the caller, never defaulted: adding a
 * contact to the organisation is a choice (a person in the contacts UI, an
 * agent through the gated share tool, an admin connecting a business system),
 * so no automated path can do it by accident.
 *
 *   - `org`:   create it org-wide (org_access 'editor', everyone reads and edits);
 *   - `owner`: create it for one person only (org_access 'none', owner-only),
 *              what automated discovery from a person's own sources does;
 *   - `none`:  never create: link to a contact that already exists and is
 *              org-visible, or return null.
 *
 * Lookups only ever match what the audience may use: `org` and `none` match
 * org-visible contacts; `owner` matches an org-visible contact first, then the
 * owner's own. Nobody's restricted contact is ever matched, merged into or
 * updated for someone else. See modules/sharing for the model.
 */
export type ContactAudience =
  | { audience: "org" }
  | { audience: "owner"; ownerUserId: string }
  | { audience: "none" }

/**
 * The audience an APP's contact resolution may create for: the organisation
 * only when the app declares `contacts.addToOrganisation` (connecting it is the
 * admin's decision to share its customers with the org); otherwise link only.
 */
export function appContactAudience(capabilities: readonly string[] | undefined): ContactAudience {
  return capabilities?.includes("contacts.addToOrganisation")
    ? { audience: "org" }
    : { audience: "none" }
}

export async function resolveContact(
  db: RlsClient,
  orgId: string,
  userId: string,
  params: ResolveContactParams,
  target: ContactAudience,
): Promise<{ contact: typeof contacts.$inferSelect | null; isNew: boolean }> {
  if (target.audience === "owner" && !UUID_RE.test(target.ownerUserId)) {
    throw new HTTPException(422, { message: "A contact's owner must be a person" })
  }
  // What this caller may match: org-visible contacts, plus the owner's own.
  const usable =
    target.audience === "owner"
      ? drizzleSql`(${contacts.orgAccess} <> 'none' OR (${contacts.ownerUserId} = ${target.ownerUserId}::uuid AND ${contacts.audienceKey} IS NULL))`
      : drizzleSql`${contacts.orgAccess} <> 'none'`
  // Org-visible first, so a person's discovery links to the organisation's
  // contact rather than keeping a private duplicate of it.
  const preferOrg = drizzleSql`CASE WHEN ${contacts.orgAccess} <> 'none' THEN 0 ELSE 1 END`

  const findExisting = async (): Promise<{
    contact: typeof contacts.$inferSelect
    wasUpdated: boolean
  } | null> => {
    const candidates: Array<ReturnType<typeof and>> = []
    // Priority-ordered lookup: email > externalId > phone
    if (params.email) {
      candidates.push(drizzleSql`LOWER(${contacts.email}) = ${params.email.toLowerCase()}`)
    }
    if (params.externalId && Object.keys(params.externalId).length > 0) {
      candidates.push(
        or(
          ...Object.entries(params.externalId).map(
            ([key, value]) =>
              drizzleSql`${contacts.externalIds} @> ${JSON.stringify({ [key]: value })}::jsonb`,
          ),
        ),
      )
    }
    if (params.phone) candidates.push(eq(contacts.phone, params.phone))
    for (const condition of candidates) {
      const [existing] = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.orgId, orgId), condition, usable))
        .orderBy(preferOrg)
        .limit(1)
      if (!existing) continue
      // Enrich only a contact of the requested audience: a person's discovery
      // never writes into the organisation's contact, and nothing writes into
      // a person's own contact but that person's audience.
      const sameAudience =
        existing.orgAccess === "none"
          ? target.audience === "owner" &&
            existing.ownerUserId === target.ownerUserId &&
            existing.audienceKey === null
          : target.audience !== "owner"
      const merged = sameAudience ? await mergeAndReturn(db, existing, params) : existing
      return { contact: merged, wasUpdated: merged !== existing }
    }
    return null
  }

  const existingResult = await findExisting()
  if (existingResult) {
    // Only emit update event when mergeAndReturn actually wrote to the DB
    if (existingResult.wasUpdated) {
      await db.queueEvent({
        app: "kernel",
        entity: "contact",
        action: "update",
        orgId,
        actorId: userId,
        entityId: existingResult.contact.id,
        data: {
          email: existingResult.contact.email,
          name: existingResult.contact.name,
          handle: existingResult.contact.handle,
        },
      })
    }
    return { contact: existingResult.contact, isNew: false }
  }
  if (target.audience === "none") return { contact: null, isNew: false }

  // No match — create it for the requested audience.
  let created: typeof contacts.$inferSelect
  const handle = await generateHandle(db)
  // System actors run with non-UUID identifiers like "system:mail:gmail-initial-sync".
  // The contacts.created_by column is uuid-typed and nullable: store NULL when the
  // userId isn't a UUID; the actor label rides on the queued event.
  const createdBy = userId && UUID_RE.test(userId) ? userId : null
  const ownerOnly = target.audience === "owner"
  const values = {
    orgId,
    handle,
    email: params.email?.toLowerCase() ?? null,
    name: params.name ?? null,
    phone: params.phone ?? null,
    company: params.company ?? null,
    externalIds: params.externalId ?? {},
    ...(params.tags && params.tags.length > 0 ? { tags: params.tags } : {}),
    ...(params.metadata && Object.keys(params.metadata).length > 0
      ? { metadata: params.metadata }
      : {}),
    createdBy,
    orgAccess: ownerOnly ? ("none" as const) : ("editor" as const),
    // A person who adds a contact to the organisation owns it (and may take
    // it back); one an app or system actor adds has no owner.
    ownerUserId: ownerOnly
      ? target.ownerUserId
      : createdBy
        ? drizzleSql`(SELECT u.id FROM ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.users u WHERE u.id = ${createdBy}::uuid)`
        : null,
  }
  const conflictSet = {
    name: params.name ?? drizzleSql`${contacts.name}`,
    phone: params.phone ?? drizzleSql`${contacts.phone}`,
    company: params.company ?? drizzleSql`${contacts.company}`,
    externalIds: params.externalId
      ? drizzleSql`${contacts.externalIds} || ${JSON.stringify(params.externalId)}::jsonb`
      : drizzleSql`${contacts.externalIds}`,
    metadata: mergeMetadataExpr(params.metadata),
    tags: mergeTagsExpr(params.tags),
    updatedAt: new Date(),
  }

  try {
    // Its own SAVEPOINT: a unique violation the upserts below do not absorb (the
    // handle index, a race on a path with no ON CONFLICT) rolls back only this
    // insert, so a caller that catches the 409 below can keep using its transaction.
    created = await db.transaction(async (sp) => {
      if (params.email) {
        // Upsert on the audience's own uniqueness (migration 0117): one
        // org-visible contact per address, one per owner and address.
        return (
          await sp
            .insert(contacts)
            .values(values)
            .onConflictDoUpdate(
              ownerOnly
                ? {
                    target: [contacts.orgId, contacts.ownerUserId, contacts.email],
                    targetWhere: drizzleSql`org_access = 'none' AND owner_user_id IS NOT NULL AND audience_key IS NULL`,
                    set: conflictSet,
                  }
                : {
                    target: [contacts.orgId, contacts.email],
                    targetWhere: drizzleSql`org_access <> 'none'`,
                    set: conflictSet,
                  },
            )
            .returning()
        )[0]!
      }
      if (params.phone && !ownerOnly) {
        // One org-visible contact per phone (contacts_org_phone_unique_idx).
        return (
          await sp
            .insert(contacts)
            .values(values)
            .onConflictDoUpdate({
              target: [contacts.orgId, contacts.phone],
              targetWhere: drizzleSql`phone IS NOT NULL AND org_access <> 'none'`,
              set: conflictSet,
            })
            .returning()
        )[0]!
      }
      return (await sp.insert(contacts).values(values).returning())[0]!
    })
    log.info({ contactId: created.id, handle, audience: target.audience }, "Contact created")
  } catch (err: any) {
    const code = err.code ?? err.cause?.code
    if (code === "23505") {
      log.warn({ orgId }, "Contact insert race detected (non-email unique constraint)")
      throw new HTTPException(409, { message: "Contact already exists — please retry" })
    }
    throw err
  }
  if (ownerOnly) {
    // The owner is on the search ACL of their own contact.
    await recomputeSearchAcl(db, "kernel.contact", created.id)
  }

  await db.queueEvent({
    app: "kernel",
    entity: "contact",
    action: "create",
    orgId,
    actorId: userId,
    entityId: created.id,
    data: { email: created.email, name: created.name, handle: created.handle },
  })

  return { contact: created, isNew: true }
}

async function mergeAndReturn(
  tx: RlsClient,
  existing: typeof contacts.$inferSelect,
  params: ResolveContactParams,
) {
  const updates: Record<string, unknown> = {}

  if (params.externalId) {
    const currentIds = (existing.externalIds as Record<string, string>) ?? {}
    updates.externalIds = { ...currentIds, ...params.externalId }
  }
  if (params.name && !existing.name) updates.name = params.name
  if (params.phone && !existing.phone) updates.phone = params.phone
  if (params.company && !existing.company) updates.company = params.company
  if (params.metadata && Object.keys(params.metadata).length > 0) {
    // Merge incoming metadata onto the existing jsonb (incoming keys win), mirroring the externalIds
    // union above — so resolving an existing contact with a new postal address accretes it rather than
    // dropping it. The CREATE path used to discard metadata entirely on a resolved-existing hit too.
    const current = (existing.metadata as Record<string, unknown> | null) ?? {}
    updates.metadata = { ...current, ...params.metadata }
  }
  if (params.tags && params.tags.length > 0) {
    const current = (existing.tags as string[] | null) ?? []
    const next = [...new Set([...current, ...params.tags])]
    if (next.length !== current.length) updates.tags = next
  }

  if (Object.keys(updates).length > 0) {
    updates.updatedAt = new Date()
    const [updated] = await tx
      .update(contacts)
      .set(updates)
      .where(and(eq(contacts.id, existing.id), eq(contacts.orgId, existing.orgId)))
      .returning()
    log.debug({ contactId: existing.id, updates: Object.keys(updates) }, "Contact updated")
    return updated
  }
  return existing
}

async function generateHandle(tx: RlsClient): Promise<string> {
  return nextHandle(tx, `${schemaRef("kernel")}.contact_handle_seq`, "@contact")
}

/**
 * Build the `tags` SET expression for an upsert: when the resolve carries new
 * tags, UNION them with the existing array (dedup, order-stable) so re-resolving
 * a contact accretes tags rather than replacing; with no new tags, keep the row
 * unchanged. Returned as a drizzle SQL fragment usable in an `onConflictDoUpdate`
 * `set`.
 */
function mergeTagsExpr(tags?: string[]) {
  if (!tags || tags.length === 0) return drizzleSql`${contacts.tags}`
  // Build ARRAY['a','b',...]::text[] from individually-bound scalar params so the
  // driver never tries to cast a multi-param record to text[] (a JS-array bind
  // expands to `($1,$2)` which Postgres reads as a record, not an array literal).
  const elems = drizzleSql.join(
    tags.map((t) => drizzleSql`${t}`),
    drizzleSql`, `,
  )
  return drizzleSql`(
    SELECT COALESCE(array_agg(DISTINCT t), '{}'::text[])
    FROM unnest(${contacts.tags} || ARRAY[${elems}]::text[]) AS t
  )`
}

/**
 * I11 — remove one app's entry from `kernel.contacts.external_ids` for every
 * contact whose `external_ids[appKey]` equals `externalId`. The contact row
 * itself is preserved (only the key under `appKey` is dropped from the jsonb).
 * Returns the number of rows updated.
 */
export async function clearContactExternalId(
  db: RlsClient,
  orgId: string,
  args: { appKey: string; externalId: string },
): Promise<number> {
  const matchPredicate = drizzleSql`${contacts.externalIds} @> ${JSON.stringify({
    [args.appKey]: args.externalId,
  })}::jsonb`
  const result = await db
    .update(contacts)
    .set({
      externalIds: drizzleSql`${contacts.externalIds} - ${args.appKey}`,
    })
    .where(and(eq(contacts.orgId, orgId), matchPredicate))
    .returning({ id: contacts.id })
  return result.length
}

export type ContactListMode = "people" | "all"

export async function listContacts(
  db: RlsClient,
  params: {
    orgId: string
    page: number
    limit: number
    query?: string
    mode?: ContactListMode
    tag?: string
    /**
     * Recency filter (BL-258): restrict to contacts whose computed `lastContactedAt` (the MAX
     * `last_message_at` across their linked mail conversations) is strictly BEFORE this ISO cutoff,
     * OR who have never been contacted at all (NULL). This is the "haven't emailed in N days"
     * predicate — the agent passes `notContactedSince = now − N days` to select stale contacts
     * directly, instead of paging the whole set and screening each in-context. The UI already
     * computes + sorts by `lastContactedAt`; this exposes the same recency dimension as a filter.
     */
    notContactedSince?: string
    /**
     * Created-date filter (BL-FIRST / weekly-enrich-new-contacts-routine): restrict to contacts whose
     * `created_at` is at or AFTER this ISO cutoff — the "recently created / created this week" predicate.
     * The enrichment routine targets "contacts created in the past week that are missing a company or
     * phone"; without this the flash-lite tick had to PAGE the whole set and screen each `created_at`
     * in-context (the unreliable in-context discrimination the l710/l711/l713/l714 doctrine moves
     * server-side). `createdAfter = now − 7 days` selects the recent set directly.
     *
     * ⚠ For a RECURRING routine, prefer `createdWithinDays` (below) over a literal `createdAfter` ISO —
     * a hardcoded ISO date in a stored routine prompt FREEZES the look-back window so every future tick
     * looks back to the same fixed date instead of a rolling window. `createdWithinDays` is resolved to
     * `now() − N days` AT QUERY TIME, so it rolls correctly each tick.
     */
    createdAfter?: string
    /**
     * Rolling created-date window (BL-FIRST): select contacts created within the last N days, resolved
     * to `created_at >= now() − N days` AT QUERY TIME. This is the ROLLING sibling of `createdAfter` —
     * the correct form for a recurring routine ("contacts created in the past week"), because it is
     * re-evaluated each tick instead of freezing to a literal date. When BOTH are given, the stricter
     * (later) cutoff wins. N is clamped to a sane range (1..3660 days).
     */
    createdWithinDays?: number
    /**
     * Field-emptiness filter (BL-FIRST). Select contacts MISSING a company and/or a phone — the "bare /
     * needs-enrichment" predicate the weekly enrichment routine sweeps. Each flag, when true, ANDs an
     * `IS NULL OR = ''` condition on that column:
     *   • hasNoCompany — company IS NULL or empty
     *   • hasNoPhone   — phone IS NULL or empty
     * Both true ⇒ missing BOTH (the strictly-bare set). A routine that wants "missing company OR phone"
     * can run two scoped searches (one per flag) or screen the OR in-context from the union; the common
     * sweep target ("created recently with NO company AND NO phone") is exactly `createdAfter` +
     * hasNoCompany + hasNoPhone. This is the server-side `missingField` the prior tool description said
     * did not exist — built so the tick RENDERS the bare-recent set instead of guessing it.
     */
    hasNoCompany?: boolean
    hasNoPhone?: boolean
    /** Only members of this contact group (S15), as far as the caller can see them. */
    groupId?: string
  },
) {
  const {
    orgId,
    page,
    limit,
    query,
    mode = "people",
    tag,
    notContactedSince,
    createdAfter,
    createdWithinDays,
    hasNoCompany,
    hasNoPhone,
    groupId,
  } = params
  const offset = (page - 1) * limit

  const isAutomatedExpr = drizzleSql<boolean>`(
    ${contacts.email} IS NOT NULL
    AND ${contacts.email} ~* ${AUTOMATED_EMAIL_PATTERN}
  )`

  // app_mail.conversations is owned by the mail app — reference by quoted ident
  // so we don't have to import the schema (kernel module stays decoupled).
  const conversationsTable = drizzleSql.raw(`${quoteIdent(schemaRef("app_mail"))}.conversations`)
  // CORRELATION FIX (BL-258): the outer contact id MUST be referenced as the FULLY-QUALIFIED column
  // inside these correlated subqueries. Interpolating `${contacts.id}` here renders as a BARE `"id"`
  // (drizzle uses the short form for a known column), which inside the subquery binds to the INNER
  // alias `c` (conversations also has an `id`) instead of the outer contact — so the correlation
  // silently matched `c.contact_id = c.id` (never true) and lastContactedAt + the recency sort were
  // ALWAYS null. Qualify with the real schema-prefixed table so it binds to the outer row.
  const contactIdQualified = drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}.contacts.id`)

  // "Last activity" is the most recent real interaction with a contact across
  // every app that records one, not mail alone. A customer with an invoice
  // issued yesterday but no mail thread previously read "never" — the column
  // means last ACTIVITY, so it must fold in the other cheap per-contact signals.
  //
  // Mail is always present (kernel-adjacent). Invoicing is an OPTIONAL installed
  // app, so its `documents` table may not exist in this org's schema set; probe
  // once with to_regclass and only union it in when present (same guard the merge
  // path uses). An invoice's activity date is COALESCE(issued_at, created_at) —
  // a draft not yet issued still counts as activity from its creation.
  const mailActivity = drizzleSql`(
    SELECT MAX(c.last_message_at)
    FROM ${conversationsTable} c
    WHERE c.org_id = ${orgId} AND c.contact_id = ${contactIdQualified}
  )`

  const invoicingDocsQualified = `${schemaRef("app_invoicing")}.documents`
  const [invReg] = extractRows<{ t: string | null }>(
    await db.execute(drizzleSql`SELECT to_regclass(${invoicingDocsQualified}) AS t`),
  )
  const invoicingActivity = invReg?.t
    ? drizzleSql`, (
        SELECT MAX(COALESCE(d.issued_at, d.created_at))
        FROM ${drizzleSql.raw(`${quoteIdent(schemaRef("app_invoicing"))}.documents`)} d
        WHERE d.org_id = ${orgId} AND d.counterparty_contact_id = ${contactIdQualified}
      )`
    : drizzleSql``

  // GREATEST ignores NULL args (Postgres), so a contact with only one signal
  // still resolves to that signal; a contact with none resolves to NULL ("never").
  const lastActivityScalar = drizzleSql`GREATEST(${mailActivity}${invoicingActivity})`
  const lastContactedExpr = drizzleSql<string | null>`(${lastActivityScalar})::text`

  const conditions = [eq(contacts.orgId, orgId)]
  if (query?.trim()) {
    const pattern = `%${query.trim()}%`
    conditions.push(
      or(
        drizzleSql`${contacts.name} ILIKE ${pattern}`,
        drizzleSql`${contacts.email} ILIKE ${pattern}`,
        drizzleSql`${contacts.company} ILIKE ${pattern}`,
        // BL-03 — match the stored VAT number and country (external_ids jsonb). A counterparty an
        // agent only knows by VAT (e.g. an intra-EU dealer "IT12345678901") or by country code was
        // previously unfindable (name/email/company only), forcing a re-create. `->>` extracts the
        // text value; absent keys yield NULL (ILIKE NULL → not matched), so this only ever widens.
        drizzleSql`${contacts.externalIds}->>'vat_id' ILIKE ${pattern}`,
        drizzleSql`${contacts.externalIds}->>'country' ILIKE ${pattern}`,
      )!,
    )
  }
  if (tag?.trim()) {
    // Tag containment via the GIN-indexed text[] column. `@>` returns FALSE for a
    // non-matching tag (never the whole list), so a no-match filter yields empty.
    conditions.push(drizzleSql`${contacts.tags} @> ARRAY[${tag.trim()}]::text[]`)
  }
  if (notContactedSince?.trim()) {
    // BL-258 recency predicate. A contact qualifies as "not contacted since <cutoff>" when the MAX
    // last_message_at across its linked mail conversations is strictly BEFORE the cutoff, OR it has
    // never been contacted (the subquery is NULL). Both cases mean "we haven't emailed them since".
    // Correlated subquery (not the aliased SELECT expr, which isn't referenceable in WHERE).
    // Uses the SAME cross-app last-activity scalar as the SELECT/sort so "stale"
    // means stale across mail AND invoicing, not mail alone.
    const cutoff = notContactedSince.trim()
    conditions.push(
      drizzleSql`(${lastActivityScalar} IS NULL OR ${lastActivityScalar} < ${cutoff}::timestamptz)`,
    )
  }
  if (createdAfter?.trim()) {
    // BL-FIRST created-date predicate (weekly-enrich-new-contacts-routine): "created this week /
    // recently created". A contact qualifies when its created_at is at or after the cutoff.
    conditions.push(drizzleSql`${contacts.createdAt} >= ${createdAfter.trim()}::timestamptz`)
  }
  if (typeof createdWithinDays === "number" && Number.isFinite(createdWithinDays)) {
    // BL-FIRST ROLLING created-date window: resolved to now() − N days AT QUERY TIME so a recurring
    // routine's look-back rolls each tick (vs a frozen literal createdAfter). Clamp to a sane range.
    const n = Math.min(3660, Math.max(1, Math.floor(createdWithinDays)))
    conditions.push(
      drizzleSql`${contacts.createdAt} >= now() - (${String(n)} || ' days')::interval`,
    )
  }
  if (hasNoCompany === true) {
    // BL-FIRST field-emptiness predicate: company missing (NULL or empty/whitespace).
    conditions.push(drizzleSql`(${contacts.company} IS NULL OR btrim(${contacts.company}) = '')`)
  }
  if (hasNoPhone === true) {
    // BL-FIRST field-emptiness predicate: phone missing (NULL or empty/whitespace).
    conditions.push(drizzleSql`(${contacts.phone} IS NULL OR btrim(${contacts.phone}) = '')`)
  }
  if (groupId) {
    conditions.push(memberOfGroupCondition(groupId))
  }
  if (mode === "people" && !groupId) {
    // A group's members are hand-picked, so the group filter shows every one of
    // them, automated senders included.
    // Hide notification senders by default; an explicit query string overrides
    // (so `?query=noreply` still finds them).
    if (!query?.trim()) {
      conditions.push(drizzleSql`NOT ${isAutomatedExpr}`)
    }
  }
  const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions)!

  const rows = await db
    .select({
      id: contacts.id,
      orgId: contacts.orgId,
      handle: contacts.handle,
      email: contacts.email,
      name: contacts.name,
      phone: contacts.phone,
      company: contacts.company,
      externalIds: contacts.externalIds,
      metadata: contacts.metadata,
      tags: contacts.tags,
      createdBy: contacts.createdBy,
      createdAt: contacts.createdAt,
      updatedAt: contacts.updatedAt,
      isAutomated: isAutomatedExpr,
      lastContactedAt: lastContactedExpr,
      _total: drizzleSql<number>`COUNT(*) OVER()::int`,
    })
    .from(contacts)
    .where(whereClause)
    // Sort by last activity (most recent interaction first, across mail AND
    // invoicing), falling back to created date for never-active records. NULLS
    // LAST keeps the head of the list useful.
    .orderBy(drizzleSql`${lastActivityScalar} DESC NULLS LAST`, desc(contacts.createdAt))
    .limit(limit)
    .offset(offset)

  const total = rows[0]?._total ?? 0
  return { rows: rows.map(({ _total, ...rest }) => rest), total }
}

// ---------------------------------------------------------------------------
// contacts_find_duplicates — server-side duplicate-CLUSTER detection (BL-266)
// ---------------------------------------------------------------------------
//
// The honest-partial dedupe scenario established that there is NO agent-callable
// duplicate-detection primitive: contacts_search is ILIKE-substring + 50/page, so a
// weak model name-by-name guesses and then FABRICATES completeness ("I scanned all 120
// and found every duplicate"). This builds the grounded path: scan the org's WHOLE
// contact set server-side, cluster likely-duplicate records by normalized signals, and
// return clusters with a confidence TIER so the model can merge HIGH-confidence pairs and
// SURFACE needs-confirmation ones — instead of guessing.
//
// Signals (all computed here, not via the capped search):
//   • email-normalized match — case-fold + provider-norm the LOCAL part (strip +tag, strip
//     dots for gmail-style providers) → same normalized address ⇒ very strong signal.
//   • name match — accent-fold + lowercase + collapse punctuation/spacing; then compare
//     normalized full names AND a (firstInitial/firstName, lastName) shape so "B. Carvalho"
//     clusters with "Beatriz Carvalho" and "Zoé"/"Zoe" collapse — but a DIFFERENT given-name
//     ROOT ("Mikkel" vs "Michael") never clusters on name alone.
//   • shared externalIds — the SAME provider customer id (shopify/reverb/…) on two records.
//
// Confidence:
//   • high — name agrees AND (same normalized email OR same company OR a shared externalId),
//     OR a shared externalId on its own (a provider id collision is a hard same-customer signal).
//     These are safe to propose for merge.
//   • needs_confirmation — a corroborating signal WITHOUT full name agreement (shared surname +
//     company but a DIFFERENT first-name root), or a name variant with NO second signal. These
//     MUST be surfaced for a human, NEVER auto-merged (merge is irreversible).
//
// Bounded + honest: the scan reads up to `scanCap` contacts (default 500) ordered newest-first
// and reports `scannedCount` / `totalCount`; when totalCount > scannedCount the result is flagged
// `coveragePartial:true` so the agent states real coverage rather than claiming completeness. The
// returned cluster list is capped (`maxClusters`, default 50) by descending confidence. It is a
// READ — it stages nothing; the gated, irreversible contacts_merge it feeds is unchanged.

/** Accent-fold + lowercase a string and collapse internal punctuation/whitespace to single spaces. */
export function normalizeNameForDedup(raw: string | null | undefined): string {
  if (!raw) return ""
  return (
    raw
      .normalize("NFKD")
      // strip combining accents
      .replace(/[̀-ͯ]/g, "")
      // common ligature / umlaut transliterations not covered by NFKD decomposition
      .replace(/ß/gi, "ss")
      .replace(/æ/gi, "ae")
      .replace(/ø/gi, "o")
      .toLowerCase()
      // treat hyphens / dots / apostrophes as spaces so "Vogt-Reiner" == "Vogt Reiner"
      .replace(/[-_.'`]/g, " ")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  )
}

/**
 * Normalize an email for duplicate detection: lowercase, strip a +tag from the local part, and for
 * dot-insignificant providers (gmail/googlemail) strip dots from the local part. Returns "" for a
 * blank/invalid email (an empty normalized email NEVER matches another — we don't cluster on "no email").
 */
export function normalizeEmailForDedup(raw: string | null | undefined): string {
  if (!raw) return ""
  const email = raw.trim().toLowerCase()
  const at = email.lastIndexOf("@")
  if (at <= 0 || at === email.length - 1) return ""
  let local = email.slice(0, at)
  const domain = email.slice(at + 1)
  const plus = local.indexOf("+")
  if (plus >= 0) local = local.slice(0, plus)
  if (domain === "gmail.com" || domain === "googlemail.com") local = local.replace(/\./g, "")
  if (local === "") return ""
  return `${local}@${domain}`
}

/** Extract a comparable name shape (first token, last token, all surname tokens), accent-folded. */
function nameShape(raw: string | null | undefined): {
  first: string
  last: string
  surnameTokens: string[]
  full: string
} {
  const full = normalizeNameForDedup(raw)
  const tokens = full.split(" ").filter(Boolean)
  if (tokens.length === 0) return { first: "", last: "", surnameTokens: [], full: "" }
  if (tokens.length === 1) return { first: tokens[0], last: "", surnameTokens: [], full }
  return {
    first: tokens[0],
    last: tokens[tokens.length - 1],
    // everything after the given name is a surname token (handles "Tavares Reis", "S. Krishnan",
    // "Vogt Reiner") — a middle initial / particle added by one import shouldn't break the match.
    surnameTokens: tokens.slice(1),
    full,
  }
}

/** True when two surname-token lists describe the same surname: equal, a one-char typo on the last
 *  token, OR one list's tokens are a SUBSET of the other's (an import added a middle initial / second
 *  surname / particle, e.g. "tavares" ⊂ "tavares reis", "krishnan" ⊂ "s krishnan"). */
function surnamesMatch(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  const aLast = a[a.length - 1]
  const bLast = b[b.length - 1]
  if (isOneEditOrTranspose(aLast, bLast)) return true
  const aSet = new Set(a)
  const bSet = new Set(b)
  const subset = (small: string[], big: Set<string>) => small.every((t) => big.has(t))
  return subset(a, bSet) || subset(b, aSet)
}

/** Damerau-ish bound: a SINGLE adjacent transposition or one-char substitution (typo like Zhang/Zhnag). */
function isOneEditOrTranspose(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  // equal length: allow one substitution OR one adjacent transposition
  if (a.length === b.length) {
    let diff = 0
    const diffs: number[] = []
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        diff++
        diffs.push(i)
        if (diff > 2) return false
      }
    }
    if (diff === 1) return true
    if (diff === 2) {
      const [i, j] = diffs
      return j === i + 1 && a[i] === b[j] && a[j] === b[i]
    }
    return diff === 0
  }
  // length differs by 1: allow one insertion/deletion
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a]
  let i = 0
  let j = 0
  let skipped = false
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++
      j++
    } else {
      if (skipped) return false
      skipped = true
      j++
    }
  }
  return true
}

/**
 * Decide whether two NAMES describe the same person for clustering purposes. Returns:
 *   "full"    — the same given-name root AND the same surname (high-confidence name match):
 *               full normalized equality, OR initial-vs-fullname on the SAME first letter
 *               ("b carvalho" ~ "beatriz carvalho"), OR a one-char surname typo with identical
 *               given name, OR a first-name abbreviation/prefix ("kat" ~ "katarina") with same surname.
 *   "surname" — the SAME surname but a DIFFERENT given-name root (the Mikkel-vs-Michael TRAP): a
 *               weak corroboration only — NEVER a high-confidence merge on its own.
 *   "none"    — unrelated.
 */
export function compareNames(
  aRaw: string | null | undefined,
  bRaw: string | null | undefined,
): "full" | "surname" | "none" {
  const a = nameShape(aRaw)
  const b = nameShape(bRaw)
  if (!a.full || !b.full) return "none"
  if (a.full === b.full) return "full"
  // Need a shared surname (equal / one-char typo / subset-with-added-particle) to be in the same
  // family of candidates at all.
  if (!surnamesMatch(a.surnameTokens, b.surnameTokens)) return "none"
  const af = a.first
  const bf = b.first
  // Same first-name root? initial-vs-name, abbreviation/prefix, or one-char typo of the first name.
  const initialMatch =
    (af.length === 1 && bf.startsWith(af)) || (bf.length === 1 && af.startsWith(bf))
  const prefixMatch = af.length >= 2 && bf.length >= 2 && (af.startsWith(bf) || bf.startsWith(af))
  const typoMatch = af.length >= 3 && bf.length >= 3 && isOneEditOrTranspose(af, bf)
  if (initialMatch || prefixMatch || typoMatch) return "full"
  // Shared surname, genuinely different given-name root → the irreversible-merge trap.
  return "surname"
}

export interface DuplicateCandidate {
  id: string
  name: string | null
  email: string | null
  company: string | null
  externalIds: Record<string, string> | null
  /** which signal connected this contact to the cluster (for the agent + UI to explain the match) */
  matchedOn: string[]
}

export interface DuplicateCluster {
  confidence: "high" | "needs_confirmation"
  /** the strongest signal that formed the cluster, e.g. "email", "externalId:shopify", "name+company" */
  signal: string
  contacts: DuplicateCandidate[]
}

interface DedupRow {
  id: string
  name: string | null
  email: string | null
  company: string | null
  externalIds: Record<string, string> | null
}

/**
 * Pure clustering over an already-fetched contact set. Exported so the trap-exclusion / genuine-pair
 * regression test exercises the detection logic deterministically without a DB round-trip.
 *
 * Builds an edge between two contacts when a same-person signal fires (normalized email, shared
 * externalId, or a "full" name match corroborated by company/email/externalId), then unions connected
 * components into clusters. A pair sharing ONLY a surname (different given-name root) or a lone
 * unconfirmed name-variant becomes a needs_confirmation edge — surfaced, never high-confidence.
 */
export function clusterDuplicates(rows: DedupRow[]): DuplicateCluster[] {
  const n = rows.length
  const norm = rows.map((r) => ({
    email: normalizeEmailForDedup(r.email),
    company: normalizeNameForDedup(r.company),
    extern: r.externalIds ?? {},
  }))

  // Collect every candidate edge with its signals + whether it is a high-confidence (mergeable) link.
  // CRITICAL: a low (needs_confirmation) edge must NOT chain records together transitively — a lone
  // name-match to a TRAP ("Sören Bachmann"@Reef vs @Klangbox) or to a distractor that happens to share
  // a normalized full name would otherwise contaminate a genuine high-confidence pair and demote it, or
  // pull an unrelated record into a real cluster. So we build HIGH-confidence clusters via union-find
  // over HIGH edges ONLY; low edges become standalone needs_confirmation PAIRS, never unioned in.
  interface Edge {
    i: number
    j: number
    signal: string
    high: boolean
  }
  const edges: Edge[] = []

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ni = norm[i]
      const nj = norm[j]
      // 1) shared externalId (same provider customer id) — a hard same-customer signal on its own.
      let sharedExternal: string | null = null
      for (const [key, val] of Object.entries(ni.extern)) {
        if (val && nj.extern[key] && nj.extern[key] === val) {
          sharedExternal = key
          break
        }
      }
      if (sharedExternal) {
        edges.push({ i, j, signal: `externalId:${sharedExternal}`, high: true })
        continue
      }
      // 2) same normalized email — drift imports never literally reuse an address, but a +tag/dot
      //    variant or a re-typed same address can; treat an exact normalized match as high-confidence.
      if (ni.email && nj.email && ni.email === nj.email) {
        edges.push({ i, j, signal: "email", high: true })
        continue
      }
      // 3) name-based. A "full" name match is high-confidence ONLY with a corroborating signal
      //    (same company, since drift across channels changes the email). A lone name variant with no
      //    corroboration, or a shared-surname/different-first-name pair, is needs_confirmation.
      const nameRel = compareNames(rows[i].name, rows[j].name)
      if (nameRel === "none") continue
      const sameCompany = ni.company !== "" && ni.company === nj.company
      if (nameRel === "full") {
        if (sameCompany) edges.push({ i, j, signal: "name+company", high: true })
        // same person name but no corroborating company/email — surface, don't auto-merge.
        else edges.push({ i, j, signal: "name", high: false })
      } else if (sameCompany) {
        // "surname" — shared surname, different given-name root → the irreversible-merge TRAP. Only an
        // edge at all if company ALSO matches (else two unrelated people who share a surname); even then
        // it is needs_confirmation and must never be high-confidence.
        edges.push({ i, j, signal: "surname+company", high: false })
      }
    }
  }

  // Phase 1: union-find over HIGH edges only → high-confidence clusters.
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    while (parent[x] !== r) {
      const next = parent[x]
      parent[x] = r
      x = next
    }
    return r
  }
  const highSignalsByMember = new Map<number, Set<string>>()
  for (const e of edges) {
    if (!e.high) continue
    const ra = find(e.i)
    const rb = find(e.j)
    if (ra !== rb) parent[ra] = rb
    for (const m of [e.i, e.j]) {
      const s = highSignalsByMember.get(m) ?? new Set<string>()
      s.add(e.signal)
      highSignalsByMember.set(m, s)
    }
  }

  const highComponents = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    if (!highSignalsByMember.has(i)) continue
    const r = find(i)
    const g = highComponents.get(r) ?? []
    g.push(i)
    highComponents.set(r, g)
  }
  const memberInHighCluster = new Set<number>()
  for (const idxs of highComponents.values()) for (const i of idxs) memberInHighCluster.add(i)

  const clusters: DuplicateCluster[] = []
  for (const idxs of highComponents.values()) {
    if (idxs.length < 2) continue
    const signalSet = new Set<string>()
    for (const i of idxs) for (const s of highSignalsByMember.get(i) ?? []) signalSet.add(s)
    clusters.push({
      confidence: "high",
      signal: [...signalSet].sort().join(", "),
      contacts: idxs.map((i) => ({
        id: rows[i].id,
        name: rows[i].name,
        email: rows[i].email,
        company: rows[i].company,
        externalIds: rows[i].externalIds,
        matchedOn: [...(highSignalsByMember.get(i) ?? [])].sort(),
      })),
    })
  }

  // Phase 2: needs_confirmation PAIRS from the low edges. Each low edge surfaces as its OWN 2-record
  // candidate (no transitive chaining) so a weak model sees exactly which records to ask about — and a
  // trap never demotes or pollutes a high-confidence cluster. Skip a low edge whose BOTH endpoints are
  // already co-located in the SAME high cluster (the high signal already consolidates them).
  const sameHighCluster = (a: number, b: number) =>
    memberInHighCluster.has(a) && memberInHighCluster.has(b) && find(a) === find(b)
  const seenLowPair = new Set<string>()
  for (const e of edges) {
    if (e.high) continue
    if (sameHighCluster(e.i, e.j)) continue
    const key = e.i < e.j ? `${e.i}:${e.j}` : `${e.j}:${e.i}`
    if (seenLowPair.has(key)) continue
    seenLowPair.add(key)
    clusters.push({
      confidence: "needs_confirmation",
      signal: e.signal,
      contacts: [e.i, e.j].map((i) => ({
        id: rows[i].id,
        name: rows[i].name,
        email: rows[i].email,
        company: rows[i].company,
        externalIds: rows[i].externalIds,
        matchedOn: [e.signal],
      })),
    })
  }

  // high-confidence first, then by cluster size (bigger = more drift to consolidate).
  clusters.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === "high" ? -1 : 1
    return b.contacts.length - a.contacts.length
  })
  return clusters
}

export interface FindDuplicatesResult {
  clusters: DuplicateCluster[]
  /** number of contacts actually scanned (≤ scanCap) */
  scannedCount: number
  /** server count of ALL contacts in the org (for honest coverage reporting) */
  totalCount: number
  /** true when totalCount > scannedCount — the agent must NOT claim completeness */
  coveragePartial: boolean
  /** count of high-confidence clusters (safe-to-merge) and needs-confirmation clusters (surface only) */
  highConfidenceCount: number
  needsConfirmationCount: number
}

/**
 * Scan the org's whole contact set (bounded by `scanCap`) and return candidate duplicate clusters with
 * a confidence tier. RLS-scoped READ — runs under the caller's db, stages nothing. See clusterDuplicates
 * for the signal/confidence rules and the trap-exclusion guarantee.
 */
export async function findDuplicateClusters(
  db: RlsClient,
  params: { orgId: string; scanCap?: number; maxClusters?: number },
): Promise<FindDuplicatesResult> {
  const scanCap = Math.min(Math.max(params.scanCap ?? 500, 1), 1000)
  const maxClusters = Math.min(Math.max(params.maxClusters ?? 50, 1), 200)

  const rows = await db
    .select({
      id: contacts.id,
      name: contacts.name,
      email: contacts.email,
      company: contacts.company,
      externalIds: contacts.externalIds,
      _total: drizzleSql<number>`COUNT(*) OVER()::int`,
    })
    .from(contacts)
    .where(eq(contacts.orgId, params.orgId))
    .orderBy(desc(contacts.createdAt))
    .limit(scanCap)

  const totalCount = rows[0]?._total ?? 0
  const scannedCount = rows.length
  const clustersAll = clusterDuplicates(rows.map(({ _total, ...r }) => r as DedupRow))
  const clusters = clustersAll.slice(0, maxClusters)
  const highConfidenceCount = clustersAll.filter((c) => c.confidence === "high").length
  const needsConfirmationCount = clustersAll.length - highConfidenceCount

  return {
    clusters,
    scannedCount,
    totalCount,
    coveragePartial: totalCount > scannedCount,
    highConfidenceCount,
    needsConfirmationCount,
  }
}

interface MergeContactsParams {
  orgId: string
  userId: string
  sourceId: string
  targetId: string
  resolvedFields?: {
    name?: string
    email?: string
    phone?: string
    company?: string
    externalIds?: Record<string, string>
    metadata?: Record<string, unknown>
  }
  mergedConversationCount?: number
  /** The source's discussion messages moved into the target's (mergeContactDiscussion). */
  discussionMoved?: boolean
}

async function mergeContactsInTx(db: RlsClient | RlsTx, params: MergeContactsParams) {
  const { orgId, userId, sourceId, targetId, resolvedFields } = params

  if (sourceId === targetId) {
    throw new HTTPException(422, { message: "Cannot merge a contact with itself" })
  }

  const [source] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, sourceId), eq(contacts.orgId, orgId)))
    .limit(1)
  if (!source) throw new HTTPException(404, { message: "Source contact not found" })

  const [target] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, targetId), eq(contacts.orgId, orgId)))
    .limit(1)
  if (!target) throw new HTTPException(404, { message: "Target contact not found" })
  // A merge must never narrow who can see a contact: folding an org-visible
  // contact into a restricted one would hide it from everyone it was shared
  // with. Merge the other way round (restricted into org-visible) instead.
  if (source.orgAccess !== "none" && target.orgAccess === "none") {
    throw new HTTPException(422, {
      message:
        "Cannot merge a contact the organisation sees into a restricted one: merge the restricted contact into the shared one",
    })
  }

  const mergedExternalIds = {
    ...((source.externalIds as Record<string, string>) ?? {}),
    ...((target.externalIds as Record<string, string>) ?? {}),
  }
  const mergedMetadata = {
    ...((source.metadata as Record<string, unknown>) ?? {}),
    ...((target.metadata as Record<string, unknown>) ?? {}),
  }

  const updateValues: Record<string, unknown> = {
    externalIds: mergedExternalIds,
    metadata: mergedMetadata,
    updatedAt: new Date(),
  }
  if (resolvedFields?.name !== undefined) updateValues.name = resolvedFields.name
  if (resolvedFields?.email !== undefined) updateValues.email = resolvedFields.email
  if (resolvedFields?.phone !== undefined) updateValues.phone = resolvedFields.phone
  if (resolvedFields?.company !== undefined) updateValues.company = resolvedFields.company
  if (resolvedFields?.externalIds !== undefined)
    updateValues.externalIds = resolvedFields.externalIds
  if (resolvedFields?.metadata !== undefined) updateValues.metadata = resolvedFields.metadata

  // DELETE the source BEFORE updating the survivor. The survivor update may carry the source's email
  // onto the survivor (resolvedFields.email = the "winning" address — the documented keep-the-best-
  // email path). If the source still existed at that point, setting the survivor's email to the
  // source's address would COLLIDE on the (org_id, email) unique index and abort the whole merge with
  // a raw 23505 → the gated merge fails with handler_outcome_unknown (dedupe-scan-whole-contact-list
  // 3× gate run 2). Source data (externalIds/metadata) is already captured into the merged-* locals
  // above, so deleting first is safe and frees the email for the survivor to inherit. (NULL emails
  // never collide — Postgres allows multiple NULLs — so this only matters for the email-inherit case,
  // but ordering delete-before-update is correct unconditionally.)
  // The survivor keeps every address of the source, verification included (the
  // delete below would cascade them away).
  await db
    .update(contactAddresses)
    .set({ contactId: targetId, updatedAt: new Date() })
    .where(and(eq(contactAddresses.orgId, orgId), eq(contactAddresses.contactId, sourceId)))
  // The survivor joins every contact group the source was in (the delete below
  // cascades the source's own membership rows away).
  await db.execute(drizzleSql`
    INSERT INTO ${contactGroupMembers} (segment_id, contact_id, org_id, added_by, added_at)
    SELECT m.segment_id, ${targetId}::uuid, m.org_id, m.added_by, m.added_at
      FROM ${contactGroupMembers} m
     WHERE m.org_id = ${orgId}::uuid AND m.contact_id = ${sourceId}::uuid
    ON CONFLICT DO NOTHING`)
  await db.delete(contacts).where(and(eq(contacts.id, sourceId), eq(contacts.orgId, orgId)))

  const [updated] = await db
    .update(contacts)
    .set(updateValues)
    .where(and(eq(contacts.id, targetId), eq(contacts.orgId, orgId)))
    .returning()

  await db.queueEvent({
    app: "kernel",
    entity: "contact",
    action: "merge",
    entityId: targetId,
    orgId,
    actorId: userId,
    data: {
      sourceId,
      targetId,
      mergedConversationCount: params.mergedConversationCount ?? 0,
      discussionMoved: params.discussionMoved ?? false,
    },
  })
  await db.queueEvent({
    app: "kernel",
    entity: "contact",
    action: "update",
    entityId: targetId,
    orgId,
    actorId: userId,
    data: updated,
  })
  await db.queueEvent({
    app: "kernel",
    entity: "contact",
    action: "delete",
    entityId: sourceId,
    orgId,
    actorId: userId,
    // Frontend handlers (handleContactEvent) read `data.id` to remove the
    // contact from the local store; without this payload the WS dispatch
    // delivers `data === undefined` and the handler silently no-ops.
    data: { id: sourceId },
  })

  return updated
}

/**
 * A merge deletes the source and writes its data into the target, so the
 * CALLER (under their own RLS, before anything runs privileged) must be able
 * to delete the source and update the target: both rows are locked FOR
 * UPDATE, which Postgres only grants through the contacts UPDATE policy (the
 * DELETE policy has the same condition). Merging a contact into one that
 * more people can see is a share, so unless the source is already
 * editable by the whole organisation (or both are org read-only) the caller
 * must also manage the source's sharing.
 */
async function authorizeMerge(db: RlsClient, params: MergeContactsParams): Promise<void> {
  if (params.sourceId === params.targetId) {
    throw new HTTPException(422, { message: "Cannot merge a contact with itself" })
  }
  const visible = async (id: string) =>
    (
      await db
        .select({
          id: contacts.id,
          orgAccess: contacts.orgAccess,
          ownerUserId: contacts.ownerUserId,
        })
        .from(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.orgId, params.orgId)))
        .limit(1)
    )[0]
  const source = await visible(params.sourceId)
  if (!source) throw new HTTPException(404, { message: "Source contact not found" })
  const target = await visible(params.targetId)
  if (!target) throw new HTTPException(404, { message: "Target contact not found" })
  const writable = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      SELECT id::text AS id FROM ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.contacts
       WHERE org_id = ${params.orgId}::uuid AND id IN (${params.sourceId}::uuid, ${params.targetId}::uuid)
       FOR UPDATE`),
  ).map((r) => r.id)
  if (!writable.includes(params.sourceId) || !writable.includes(params.targetId)) {
    throw new HTTPException(403, {
      message: "You can read these contacts but not edit them: only their editors can merge them",
    })
  }
  const broadens = !(
    source.orgAccess === "editor" ||
    (source.orgAccess === "viewer" && target.orgAccess === "viewer") ||
    (await sameOwnerNoWiderGrants(db, params.orgId, source, target))
  )
  if (broadens && !(await canManageSharing(db, "kernel.contact", params.sourceId))) {
    throw new HTTPException(403, {
      message:
        "Merging this contact would show it to more people than it is shared with: only its owner can do that",
    })
  }
}

/**
 * Whether merging `source` into `target` shows the source's data to nobody new
 * when both are private: the same owner, and every grant on the target is one
 * the source carries too. Two contacts of one person's own address book then
 * have the same audience, and merging them is not a share, whoever runs it
 * (the owner, or their agent with an approved merge, which may edit the rows
 * but never manage their sharing). The grants are read as the admin role: the
 * caller's RLS may hide some, and a hidden grant must count as wider.
 */
async function sameOwnerNoWiderGrants(
  db: RlsClient,
  orgId: string,
  source: { id: string; orgAccess: string; ownerUserId: string | null },
  target: { id: string; orgAccess: string; ownerUserId: string | null },
): Promise<boolean> {
  if (source.orgAccess !== "none" || target.orgAccess !== "none") return false
  if (!source.ownerUserId || source.ownerUserId !== target.ownerUserId) return false
  const rows = await privilegedFrom(db, orgId, "contact-merge-grants", async (ptx) =>
    extractRows<{ resource_id: string; grantee_kind: string; grantee: string; role: string }>(
      await ptx.execute(drizzleSql`
        SELECT resource_id::text AS resource_id, grantee_kind, grantee, role
          FROM ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.resource_grants
         WHERE resource_type = 'kernel.contact'
           AND resource_id IN (${source.id}::uuid, ${target.id}::uuid)`),
    ),
  )
  const key = (r: { grantee_kind: string; grantee: string; role: string }) =>
    `${r.grantee_kind}:${r.grantee}:${r.role}`
  const sourceGrants = new Set(rows.filter((r) => r.resource_id === source.id).map(key))
  return rows.filter((r) => r.resource_id === target.id).every((r) => sourceGrants.has(key(r)))
}

export async function mergeContacts(db: RlsClient, params: MergeContactsParams) {
  await authorizeMerge(db, params)
  return mergeContactsInTx(db, params)
}

/**
 * The rows pointing at a contact that a merge re-points. Each is re-pointed
 * elevated (the caller may not see every column involved), but ONLY rows the
 * caller could update under their own RLS: they are locked FOR UPDATE under
 * the caller's policies first, and a merge that would have to move a row the
 * caller cannot edit (another person's mailbox, an invoice without invoicing
 * write) is refused rather than done on their behalf.
 */
const MERGE_REFERENCES = [
  { schema: "app_mail", table: "conversations", column: "contact_id", kind: "conversations" },
  {
    schema: "app_invoicing",
    table: "documents",
    column: "counterparty_contact_id",
    kind: "invoicing documents",
  },
] as const

/**
 * An invoicing counterparty identity is one row per contact (unique contact_id), so a merge
 * cannot re-point it like the other references: when both contacts hold one, the confirmed
 * one survives (a tie keeps the target's) and the other is deleted. Runs in the merge
 * transaction, before the generic re-point; a database without the invoicing app is skipped.
 */
const IDENTITY_TABLE = { schema: "app_invoicing", table: "counterparty_identities" } as const

async function identityTableExists(db: RlsClient | RlsTx): Promise<boolean> {
  const [reg] = extractRows<{ t: string | null }>(
    await db.execute(
      drizzleSql`SELECT to_regclass(${`${schemaRef(IDENTITY_TABLE.schema)}.${IDENTITY_TABLE.table}`}) AS t`,
    ),
  )
  return Boolean(reg?.t)
}

function identityTable() {
  return drizzleSql.raw(
    `${quoteIdent(schemaRef(IDENTITY_TABLE.schema))}.${quoteIdent(IDENTITY_TABLE.table)}`,
  )
}

async function mergeCounterpartyIdentities(
  tx: RlsClient | RlsTx,
  params: MergeContactsParams,
): Promise<void> {
  if (!(await identityTableExists(tx))) return
  const table = identityTable()
  const rows = extractRows<{ id: string; contact_id: string; confirmed_via: string | null }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, contact_id::text AS contact_id, confirmed_via
        FROM ${table}
       WHERE org_id = ${params.orgId}::uuid
         AND contact_id IN (${params.sourceId}::uuid, ${params.targetId}::uuid)
         FOR UPDATE`),
  )
  const source = rows.find((r) => r.contact_id === params.sourceId)
  if (!source) return
  const target = rows.find((r) => r.contact_id === params.targetId)
  const note = `merged from ${params.sourceId}`
  const sourceWins = !target || (source.confirmed_via !== null && target.confirmed_via === null)
  const keep = sourceWins ? source : target
  if (!keep) return
  if (target && sourceWins) {
    await tx.execute(drizzleSql`DELETE FROM ${table} WHERE id = ${target.id}::uuid`)
  } else if (target && !sourceWins) {
    await tx.execute(drizzleSql`DELETE FROM ${table} WHERE id = ${source.id}::uuid`)
  }
  await tx.execute(drizzleSql`
    UPDATE ${table}
       SET contact_id = ${params.targetId}::uuid,
           notes = CASE WHEN notes IS NULL OR notes = '' THEN ${note} ELSE notes || E'\n' || ${note} END,
           updated_at = now()
     WHERE id = ${keep.id}::uuid`)
}

/** Lock the contacts' identity rows under the caller's RLS; a row the caller cannot edit refuses the merge. */
async function lockMergeIdentities(db: RlsClient, params: MergeContactsParams): Promise<void> {
  if (!(await identityTableExists(db))) return
  const table = identityTable()
  const where = drizzleSql`org_id = ${params.orgId}::uuid AND contact_id IN (${params.sourceId}::uuid, ${params.targetId}::uuid)`
  const [all] = await asAdmin(db, async () =>
    extractRows<{ n: number }>(
      await db.execute(drizzleSql`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`),
    ),
  )
  const ids = extractRows<{ id: string }>(
    await db.execute(drizzleSql`SELECT id::text AS id FROM ${table} WHERE ${where} FOR UPDATE`),
  )
  if (ids.length < (all?.n ?? 0)) {
    throw new HTTPException(409, {
      message: `This contact has an invoicing identity you cannot edit: ask someone who can edit it to merge it`,
    })
  }
}

async function lockMergeReferences(
  db: RlsClient,
  params: MergeContactsParams,
): Promise<Array<{ ref: (typeof MERGE_REFERENCES)[number]; ids: string[] }>> {
  const out: Array<{ ref: (typeof MERGE_REFERENCES)[number]; ids: string[] }> = []
  await lockMergeIdentities(db, params)
  for (const ref of MERGE_REFERENCES) {
    const qualified = `${schemaRef(ref.schema)}.${ref.table}`
    const [reg] = extractRows<{ t: string | null }>(
      await db.execute(drizzleSql`SELECT to_regclass(${qualified}) AS t`),
    )
    if (!reg?.t) continue
    const table = drizzleSql.raw(`${quoteIdent(schemaRef(ref.schema))}.${quoteIdent(ref.table)}`)
    const column = drizzleSql.raw(quoteIdent(ref.column))
    const where = drizzleSql`org_id = ${params.orgId}::uuid AND ${column} = ${params.sourceId}::uuid`
    const [all] = await asAdmin(db, async () =>
      extractRows<{ n: number }>(
        await db.execute(drizzleSql`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`),
      ),
    )
    const ids = extractRows<{ id: string }>(
      await db.execute(drizzleSql`SELECT id::text AS id FROM ${table} WHERE ${where} FOR UPDATE`),
    ).map((r) => r.id)
    if (ids.length < (all?.n ?? 0)) {
      throw new HTTPException(409, {
        message: `This contact is linked from ${(all?.n ?? 0) - ids.length} ${ref.kind} you cannot edit: ask someone who can edit them to merge it`,
      })
    }
    out.push({ ref, ids })
  }
  return out
}

export async function mergeContactsWithMailReferences(db: RlsClient, params: MergeContactsParams) {
  // The whole merge is one transaction on a login that can elevate
  // (withElevatableRlsFrom): the caller's own transaction when its login can,
  // otherwise a new RLS transaction for the same actor on the privileged pool,
  // since a request transaction on the request login cannot step into
  // liaison_admin. Authorised under the caller's RLS first, references
  // included; only then does the re-point of exactly those rows run elevated.
  return withElevatableRlsFrom(db, "contact-merge", async (etx) => {
    await authorizeMerge(etx, params)
    const locked = await lockMergeReferences(etx, params)

    // Same transaction (a savepoint), elevated for the reference rewrite: the
    // rows locked above stay locked by this very transaction, and a failure
    // anywhere rolls the whole merge back.
    return etx.transaction(async (tx) =>
      asAdmin(tx, () => applyContactMerge(tx as never, params, locked)),
    )
  })
}

/**
 * A kernel-initiated merge (no person's RLS to check against): every
 * reference is re-pointed. Used when a placeholder account is merged into the
 * real person and both hold a private contact for the same address: the two
 * become one, nothing is dropped. The caller's transaction is privileged.
 */
export async function mergeContactsAsKernel(
  tx: PrivilegedDb,
  params: MergeContactsParams,
): Promise<{ contact: typeof contacts.$inferSelect; mergedConversationCount: number }> {
  const locked: Array<{ ref: (typeof MERGE_REFERENCES)[number]; ids: string[] }> = []
  for (const ref of MERGE_REFERENCES) {
    const [reg] = extractRows<{ t: string | null }>(
      await tx.execute(
        drizzleSql`SELECT to_regclass(${`${schemaRef(ref.schema)}.${ref.table}`}) AS t`,
      ),
    )
    if (!reg?.t) continue
    const table = drizzleSql.raw(`${quoteIdent(schemaRef(ref.schema))}.${quoteIdent(ref.table)}`)
    const ids = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${table}
         WHERE org_id = ${params.orgId}::uuid AND ${drizzleSql.raw(quoteIdent(ref.column))} = ${params.sourceId}::uuid
         FOR UPDATE`),
    ).map((r) => r.id)
    locked.push({ ref, ids })
  }
  return applyContactMerge(tx as never, params, locked)
}

async function applyContactMerge(
  tx: RlsClient,
  params: MergeContactsParams,
  locked: Array<{ ref: (typeof MERGE_REFERENCES)[number]; ids: string[] }>,
): Promise<{ contact: typeof contacts.$inferSelect; mergedConversationCount: number }> {
  let mergedConversationCount = 0
  await mergeCounterpartyIdentities(tx, params)
  for (const { ref, ids } of locked) {
    if (ids.length === 0) continue
    const table = drizzleSql.raw(`${quoteIdent(schemaRef(ref.schema))}.${quoteIdent(ref.table)}`)
    const idList = drizzleSql.join(
      ids.map((id) => drizzleSql`${id}::uuid`),
      drizzleSql`, `,
    )
    // Invoicing: only the CRM back-link moves; the legal counterparty
    // snapshot frozen at issue is untouched.
    const moved = extractRows<{ id: string; account_id?: string }>(
      await tx.execute(drizzleSql`
            UPDATE ${table} SET ${drizzleSql.raw(quoteIdent(ref.column))} = ${params.targetId}::uuid,
                   updated_at = now()
             WHERE org_id = ${params.orgId}::uuid AND id IN (${idList})
            RETURNING id::text AS id${ref.table === "conversations" ? drizzleSql`, account_id::text AS account_id` : drizzleSql``}`),
    )
    if (ref.table !== "conversations") continue
    mergedConversationCount = moved.length
    for (const row of moved) {
      await (tx as any).queueEvent({
        app: "mail",
        entity: "conversation",
        action: "update",
        entityId: row.id,
        orgId: params.orgId,
        actorId: params.userId,
        actorType: "user",
        timestamp: new Date().toISOString(),
        data: { id: row.id, accountId: row.account_id, contactId: params.targetId },
      })
    }
  }

  // The source's discussion joins the survivor's before the source row goes.
  const discussionMoved = await mergeContactDiscussion(tx, {
    orgId: params.orgId,
    sourceId: params.sourceId,
    targetId: params.targetId,
    userId: params.userId,
  })
  const survivor = await mergeContactsInTx(tx as any, {
    ...params,
    mergedConversationCount,
    discussionMoved,
  })
  // Atomicity seam: nothing arms this outside a test (see
  // `merge-failpoint.ts`), so on every production path it is a no-op.
  await runAfterContactMergeFailpoint()
  return { contact: survivor, mergedConversationCount }
}

export async function getContact(db: RlsClient, params: { orgId: string; contactId: string }) {
  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, params.contactId), eq(contacts.orgId, params.orgId)))
    .limit(1)
  return contact ?? null
}

interface DeleteContactParams {
  orgId: string
  userId: string
  contactId: string
}

/**
 * `privileged`: the privileged transaction the caller already holds (a kernel
 * job deleting as part of a larger write), so the contact's discussion goes in
 * that same transaction instead of a second privileged slot.
 */
export async function deleteContact(
  db: RlsClient,
  params: DeleteContactParams,
  privileged?: PrivilegedDb,
) {
  const { orgId, userId, contactId } = params

  const [deleted] = await db
    .delete(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.orgId, orgId)))
    .returning({ id: contacts.id })

  if (!deleted) return null
  // Its discussion goes with it: a contact has no bin to restore it from. On the privileged
  // transaction the caller holds, else on the caller's own one when it may elevate, so a caller
  // already holding a privileged slot never takes a second one.
  await privilegedFrom(privileged ?? db, orgId, "contact-discussion-delete", (ptx) =>
    deleteContactDiscussions({ orgId, contactIds: [contactId] }, ptx),
  )

  await db.queueEvent({
    app: "kernel",
    entity: "contact",
    action: "delete",
    entityId: contactId,
    orgId,
    actorId: userId,
    // Frontend handler reads `data.id`; without payload the dispatch delivers
    // `undefined` and the contact stays in the cached list/detail stores.
    data: { id: contactId },
  })

  return deleted
}

interface UpdateContactParams {
  name?: string
  email?: string
  phone?: string
  company?: string
  externalIds?: Record<string, string>
  metadata?: Record<string, unknown>
  tags?: string[]
}

export async function updateContact(
  db: RlsClient,
  params: { orgId: string; userId: string; contactId: string; updates: UpdateContactParams },
) {
  // Only include explicitly provided fields to avoid nulling unspecified ones
  const setValues: Record<string, unknown> = { updatedAt: new Date() }
  if (params.updates.name !== undefined) setValues.name = params.updates.name
  // `email` IS updatable (contact enrichment fills a bare contact's email — enrich-dealer-contact-from-
  // website). It was previously omitted here, so an email passed on an UPDATE was silently dropped: the
  // write returned 2xx but the record kept email=null. Including it makes enrichment persist the email.
  if (params.updates.email !== undefined) setValues.email = params.updates.email
  if (params.updates.phone !== undefined) setValues.phone = params.updates.phone
  if (params.updates.company !== undefined) setValues.company = params.updates.company
  if (params.updates.externalIds !== undefined) setValues.externalIds = params.updates.externalIds
  if (params.updates.metadata !== undefined) setValues.metadata = params.updates.metadata
  if (params.updates.tags !== undefined) setValues.tags = params.updates.tags

  const [updated] = await db
    .update(contacts)
    .set(setValues)
    .where(and(eq(contacts.id, params.contactId), eq(contacts.orgId, params.orgId)))
    .returning()

  if (!updated) return null

  await db.queueEvent({
    app: "kernel",
    entity: "contact",
    action: "update",
    entityId: updated.id,
    orgId: params.orgId,
    actorId: params.userId,
    data: updated,
  })

  return updated
}

// ============================================================================
// Segments — a stored jsonb filter predicate evaluated LIVE against contacts.
// ============================================================================

export interface SegmentFilter {
  tag?: string
  /** Minimum lifetime spend in MINOR units (e.g. cents). Resolved from the
   *  Shopify-exposed `amountSpent` via an injected `resolveSpend` resolver. */
  minSpend?: number
}

export async function createSegment(
  db: RlsClient,
  params: { orgId: string; userId: string; name: string; filter: SegmentFilter },
): Promise<typeof contactSegments.$inferSelect> {
  const createdBy = params.userId && UUID_RE.test(params.userId) ? params.userId : null
  const [row] = await db
    .insert(contactSegments)
    .values({
      orgId: params.orgId,
      name: params.name,
      filter: params.filter,
      createdBy,
    })
    .returning()
  return row
}

/**
 * Evaluate a stored segment LIVE: re-run its filter against the current
 * contacts table (so a contact tagged AFTER the segment was created appears
 * without re-defining the segment — it is a stored query, not a materialized
 * snapshot). A `minSpend` filter is COMPUTABLE, not "uncomputable": the caller
 * injects `resolveSpend` (which mirrors the Shopify `customers_search`
 * `amountSpent`, keyed by email, minor units), and the segment keeps only
 * contacts whose resolved spend meets the floor.
 */
export async function evaluateSegment(
  db: RlsClient,
  params: {
    orgId: string
    segmentId: string
    resolveSpend?: (emails: string[]) => Promise<Map<string, number>>
  },
): Promise<Array<typeof contacts.$inferSelect>> {
  const [segment] = await db
    .select()
    .from(contactSegments)
    .where(and(eq(contactSegments.id, params.segmentId), eq(contactSegments.orgId, params.orgId)))
    .limit(1)
  if (!segment) throw new HTTPException(404, { message: "Segment not found" })

  if (segment.kind === "manual") {
    // A contact group: its hand-picked members the caller can see.
    return db
      .select()
      .from(contacts)
      .where(and(eq(contacts.orgId, params.orgId), memberOfGroupCondition(segment.id)))
  }

  const filter = (segment.filter as SegmentFilter) ?? {}
  const conditions = [eq(contacts.orgId, params.orgId)]
  if (filter.tag?.trim()) {
    conditions.push(drizzleSql`${contacts.tags} @> ARRAY[${filter.tag.trim()}]::text[]`)
  }
  const candidates = await db
    .select()
    .from(contacts)
    .where(and(...conditions))

  if (filter.minSpend === undefined) return candidates

  // Spend segment — resolve per-contact spend from the injected Shopify reader.
  // No resolver means spend is not wired in this context: degrade to NO matches
  // rather than silently returning everyone (a spend floor must actually bind).
  const minSpend = filter.minSpend
  const emails = candidates.map((c) => c.email).filter((e): e is string => Boolean(e))
  const spendByEmail = params.resolveSpend ? await params.resolveSpend(emails) : new Map()
  return candidates.filter((c) => {
    if (!c.email) return false
    const spend = spendByEmail.get(c.email) ?? 0
    return spend >= minSpend
  })
}

// ----------------------------------------------------------------------------
// Export — CSV file artifact over a segment (or the whole directory).
// RFC-4180 serializer COPIED (not shared) from the export builtin-handlers.
// ----------------------------------------------------------------------------

const CONTACTS_EXPORT_COLUMNS: Array<[string, keyof typeof contacts.$inferSelect]> = [
  ["id", "id"],
  ["handle", "handle"],
  ["name", "name"],
  ["email", "email"],
  ["phone", "phone"],
  ["company", "company"],
  ["tags", "tags"],
]

function serializeContactsCsv(rows: Array<typeof contacts.$inferSelect>): string {
  const header = CONTACTS_EXPORT_COLUMNS.map(([k]) => k).join(",")
  const body = rows
    .map((row) =>
      CONTACTS_EXPORT_COLUMNS.map(([, dbKey]) => {
        const v = row[dbKey]
        return exportCsvCell(Array.isArray(v) ? v.join("|") : v)
      }).join(","),
    )
    .join("\n")
  return body ? `${header}\n${body}\n` : `${header}\n`
}

/**
 * Export contacts (optionally scoped to a segment, or a single tag) to a CSV
 * `kernel.files` artifact. Requires the `kernel:contacts:export` scope —
 * exporting PII is a privileged boundary — and `kernel:contacts:read`. Reads
 * are RLS-bound (the export never escalates visibility); the resulting file is materialized under a privileged
 * tx (quota check + insert), mirroring the Drive importer seam.
 */
export async function exportContactsToFile(
  db: RlsClient,
  params: {
    orgId: string
    userId: string
    scopes: string[]
    format: "csv"
    segmentId?: string
    tag?: string
    resolveSpend?: (emails: string[]) => Promise<Map<string, number>>
  },
): Promise<{ fileId: string }> {
  if (!hasScope(params.scopes, "kernel:contacts:export")) {
    throw new HTTPException(403, {
      message: "Missing required scope kernel:contacts:export",
    })
  }
  // An export materializes contacts (and, over a contact group, its membership), so the
  // caller must also be allowed to read contacts: export alone is not a read grant.
  if (!hasScope(params.scopes, "kernel:contacts:read")) {
    throw new HTTPException(403, {
      message: "Missing required scope kernel:contacts:read (an export materializes contacts)",
    })
  }

  let rows: Array<typeof contacts.$inferSelect>
  if (params.segmentId) {
    rows = await evaluateSegment(db, {
      orgId: params.orgId,
      segmentId: params.segmentId,
      resolveSpend: params.resolveSpend,
    })
  } else {
    const conditions = [eq(contacts.orgId, params.orgId)]
    if (params.tag?.trim()) {
      conditions.push(drizzleSql`${contacts.tags} @> ARRAY[${params.tag.trim()}]::text[]`)
    }
    rows = await db
      .select()
      .from(contacts)
      .where(and(...conditions))
  }

  const csv = serializeContactsCsv(rows)
  const bytes = Buffer.from(csv, "utf8")
  const filename = `contacts-export-${new Date().toISOString().slice(0, 10)}.csv`

  return withPrivilegedDb(params.orgId, "contacts:export", async (privileged) => {
    const settings = await loadOrgSettings(privileged, params.orgId)
    if (await wouldExceedOrgQuota(privileged, params.orgId, settings, bytes.byteLength)) {
      throw new HTTPException(413, { message: "Org storage quota exceeded" })
    }

    const storageKey = buildStorageKey({
      orgId: params.orgId,
      app: "kernel",
      entityType: "contacts_export",
      entityId: params.segmentId ?? "all",
      filename,
    })
    await putObject({ key: storageKey, body: bytes, contentType: "text/csv" })

    const uploadedBy = params.userId && UUID_RE.test(params.userId) ? params.userId : null
    const [row] = await privileged
      .insert(files)
      .values({
        orgId: params.orgId,
        app: "kernel",
        entityType: "contacts_export",
        entityId: params.segmentId ?? "all",
        filename,
        mimeType: "text/csv",
        sizeBytes: bytes.byteLength,
        storageKey,
        uploadedBy,
        disposition: "attachment",
      })
      .returning({ id: files.id })
    return { fileId: row.id }
  })
}

function hasScope(scopes: string[], required: string): boolean {
  // Hierarchical: holding a parent (`kernel:contacts`) implies the child action.
  return scopes.some((s) => s === required || required.startsWith(`${s}:`))
}
