// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Companies (kernel.companies, migration 0293): the organisations an org's
 * people work for, and the hub their deals, money, support and work hang off.
 *
 * Every read and write runs under the caller's RLS: a company shared with
 * nobody is invisible to whoever holds no grant on it, and a company the
 * caller cannot see answers 404, never 403. Two writes reach rows the caller's
 * RLS may not let them change, and both must commit with the change that
 * causes them, so they run elevated in the same transaction
 * (withElevatableRlsFrom + asAdmin, as the contact merge does):
 *
 *  - a rename rewrites `contacts.company` (the company name each person
 *    carries as text) on every linked person, private ones included;
 *  - a delete clears the company from deals and pipelines
 *    (`app_projects.deals.company_id`, `app_projects.projects.company_id`),
 *    which hold it as a soft reference.
 *
 * A company's domain is stored as a lowercase host and never as a personal
 * mail domain (gmail.com and the like): such a domain is dropped with a
 * notice and the company saves without one. Two companies may share a domain
 * (a group's subsidiaries); duplicates are a hint, never a refusal.
 */
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { RlsClient, RlsTx } from "~/db"
import { extractRows } from "~/db"
import { withElevatableRlsFrom, withPrivilegedDb } from "~/db/privileged"
import { type Company, companies, contacts, userRoles, users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { contactsLogger as log } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { UUID_RE } from "~/lib/uuid"
import { isConsumerMailDomain } from "~/modules/apps/connections/api/consumer-domains"
import {
  actorGrantRole,
  asAdmin,
  canManageSharing,
  listGrants,
  type OrgAccess,
  type ResourceGrants,
  replaceGrants,
} from "~/modules/sharing/service"
import {
  deleteEntityDiscussions,
  entityDiscussionHandle,
  entityDiscussionThreads,
  unindexDiscussionThreads,
} from "~/modules/threads/entity-discussion"

export const COMPANY_RESOURCE = "kernel.company"
export const COMPANY_NAME_MAX = 200
export const COMPANY_LINK_BATCH_MAX = 200

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** A refusal with a code the page and the agent can act on (409 or 422). */
export class CompanyRequestError extends Error {
  constructor(
    readonly status: 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "CompanyRequestError"
  }
}

function notFound(): HTTPException {
  return new HTTPException(404, { message: "Company not found" })
}

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } }
  return e?.cause?.code ?? e?.code
}

/* -------------------------------------------------------------------------- */
/* Domain and name normalisation                                              */
/* -------------------------------------------------------------------------- */

export type DomainResult =
  | { domain: string | null }
  | { domain: null; refused: "consumer_domain"; typed: string }

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/

/**
 * A typed domain or url as the company's lowercase host: `https://www.x.example/a`
 * is `x.example`. Empty input is no domain. A personal mail domain is refused
 * (the company saves without one); anything that is not a host is a 422.
 */
export function normaliseCompanyDomain(raw: string | null | undefined): DomainResult {
  const typed = (raw ?? "").trim()
  if (!typed) return { domain: null }
  let host = typed.toLowerCase()
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  host = host.replace(/^[^@/]*@/, "")
  host = host.split(/[/?#]/, 1)[0] ?? ""
  host = host.replace(/:\d+$/, "").replace(/\.+$/, "")
  if (host.startsWith("www.")) host = host.slice(4)
  if (!HOST_RE.test(host)) {
    throw new CompanyRequestError(
      422,
      "invalid_domain",
      `"${typed.slice(0, 100)}" is not a domain. Type it as example.com, or leave it empty.`,
    )
  }
  if (isConsumerMailDomain(host)) return { domain: null, refused: "consumer_domain", typed: host }
  return { domain: host }
}

/** The line a person reads when a personal mail domain was not saved. */
export function consumerDomainNotice(host: string): string {
  return `${host} is a personal mail domain, so it was not saved as the company's domain. The company was saved without one.`
}

/** Legal-form words that do not tell two companies apart ("Maison Arlon SAS"). */
const LEGAL_FORMS = new Set([
  "ab",
  "ag",
  "aps",
  "as",
  "bv",
  "co",
  "corp",
  "corporation",
  "eurl",
  "gmbh",
  "inc",
  "incorporated",
  "kg",
  "limited",
  "llc",
  "llp",
  "lp",
  "ltd",
  "nv",
  "oy",
  "plc",
  "pty",
  "sa",
  "sarl",
  "sas",
  "sasu",
  "sci",
  "sl",
  "snc",
  "spa",
  "srl",
  "ug",
])

/**
 * The comparison key of a company name: case, accents, punctuation and
 * trailing legal forms removed. `MAISON ARLON SAS` and `Maison Arlon` share
 * the key `maison arlon`.
 */
export function companyNameKey(raw: string | null | undefined): string {
  const words = (raw ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1]!)) words.pop()
  return words.join(" ")
}

/** The handle's readable part: `@company-maison-arlon`. */
function handleBase(name: string): string {
  const slug = companyNameKey(name)
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48)
    .replace(/-+$/, "")
  return `@company-${slug || "company"}`
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export interface CompanyInput {
  name: string
  domain?: string | null
  description?: string | null
  tags?: string[]
}

export interface CompanyPatch {
  name?: string
  domain?: string | null
  description?: string | null
  tags?: string[]
  metadata?: Record<string, unknown> | null
  /** One of the company's people, or null to clear. */
  mainContactId?: string | null
  /** True ends the relationship (closed_at now), false reopens it. */
  closed?: boolean
}

export interface CompanyWrite {
  company: Company
  /** Set when the typed domain was a personal mail domain and was not saved. */
  notice?: string
}

export interface CompanyDealSummary {
  taskId: string
  /** The deal's own title, and the board (pipeline project) it sits on. */
  title: string
  projectId: string
  stage: string | null
  /** Null for a reader without deal access, or when the deal has no amount. */
  amountMinor: number | null
  currency: string | null
}

export interface CompanyRow extends Company {
  peopleCount: number
  /** The newest open deal, for a reader who may see deals; null otherwise. */
  openDeal: CompanyDealSummary | null
}

function cleanName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ")
  if (!trimmed) throw new CompanyRequestError(422, "name_required", "A company needs a name.")
  if (trimmed.length > COMPANY_NAME_MAX) {
    throw new CompanyRequestError(
      422,
      "name_too_long",
      `A company name is at most ${COMPANY_NAME_MAX} characters.`,
    )
  }
  return trimmed
}

function cleanTags(tags: string[] | undefined): string[] | undefined {
  if (tags === undefined) return undefined
  return [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))]
}

function actorUuid(userId: string): string | null {
  return UUID_RE.test(userId) ? userId : null
}

const ks = () => drizzleSql.raw(quoteIdent(schemaRef("kernel")))
const ps = () => drizzleSql.raw(quoteIdent(schemaRef("app_projects")))

/** True when the projects app's deal tables exist in this database. */
async function dealTablesExist(tx: Pick<RlsClient, "execute">): Promise<boolean> {
  const [row] = extractRows<{ deals: string | null; projects: string | null }>(
    await tx.execute(drizzleSql`
      SELECT to_regclass(${`${quoteIdent(schemaRef("app_projects"))}.deals`})::text AS deals,
             to_regclass(${`${quoteIdent(schemaRef("app_projects"))}.projects`})::text AS projects`),
  )
  return !!row?.deals && !!row?.projects
}

/**
 * App rows that name a company by `company_id`, re-pointed by a merge in its
 * transaction. A table the database does not have (its app never installed)
 * is skipped; an app turned off still has its table, so its rows move too.
 */
const APP_COMPANY_LINKS = [
  "app_invoicing.recurring_schedules",
  // Billing customers mirrored from the payment connector.
  "app_stripe.stripe_customers",
] as const

async function repointAppCompanyLinks(
  tx: Pick<RlsClient, "execute">,
  params: { orgId: string; sourceId: string; targetId: string },
): Promise<number> {
  let moved = 0
  for (const link of APP_COMPANY_LINKS) {
    const [schema = "", table = ""] = link.split(".")
    const qualified = `${quoteIdent(schemaRef(schema))}.${quoteIdent(table)}`
    const [reg] = extractRows<{ t: string | null }>(
      await tx.execute(drizzleSql`SELECT to_regclass(${qualified})::text AS t`),
    )
    if (!reg?.t) continue
    moved += extractRows(
      await tx.execute(drizzleSql`
        UPDATE ${drizzleSql.raw(qualified)} SET company_id = ${params.targetId}::uuid, updated_at = now()
         WHERE org_id = ${params.orgId}::uuid AND company_id = ${params.sourceId}::uuid
        RETURNING id`),
    ).length
  }
  return moved
}

/** Schedules not ended that bill this company; 0 when the invoicing tables do not exist. */
async function liveSchedulesBilling(
  tx: Pick<RlsClient, "execute">,
  params: { orgId: string; companyId: string },
): Promise<number> {
  const qualified = `${quoteIdent(schemaRef("app_invoicing"))}.${quoteIdent("recurring_schedules")}`
  const [reg] = extractRows<{ t: string | null }>(
    await tx.execute(drizzleSql`SELECT to_regclass(${qualified})::text AS t`),
  )
  if (!reg?.t) return 0
  const [row] = extractRows<{ n: number }>(
    await tx.execute(drizzleSql`
      SELECT count(*)::int AS n FROM ${drizzleSql.raw(qualified)}
       WHERE org_id = ${params.orgId}::uuid AND company_id = ${params.companyId}::uuid
         AND status <> 'ended'`),
  )
  return row?.n ?? 0
}

/**
 * App rows that name a deleted company let go of it (the column is cleared), so nothing points
 * at a company that is gone: ended schedules and billing customers mirrored from the payment
 * connector, which keep their own record.
 */
async function unlinkAppCompanyRows(
  tx: Pick<RlsClient, "execute">,
  params: { orgId: string; companyId: string },
): Promise<void> {
  for (const link of APP_COMPANY_LINKS) {
    const [schema = "", table = ""] = link.split(".")
    const qualified = `${quoteIdent(schemaRef(schema))}.${quoteIdent(table)}`
    const [reg] = extractRows<{ t: string | null }>(
      await tx.execute(drizzleSql`SELECT to_regclass(${qualified})::text AS t`),
    )
    if (!reg?.t) continue
    await tx.execute(drizzleSql`
      UPDATE ${drizzleSql.raw(qualified)} SET company_id = NULL, updated_at = now()
       WHERE org_id = ${params.orgId}::uuid AND company_id = ${params.companyId}::uuid`)
  }
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Who may get a company's event over the socket (`infra/websocket.ts`):
 * everyone for an org-wide company, else its creator and the people it is
 * shared with. Read from the row the event is about.
 */
export function companyEventAudience(
  row: Pick<Company, "orgAccess" | "createdBy" | "aclUserIds">,
): { orgWide: boolean; userIds: string[] } {
  if (row.orgAccess !== "none") return { orgWide: true, userIds: [] }
  const ids = new Set<string>(row.aclUserIds ?? [])
  if (row.createdBy) ids.add(row.createdBy)
  return { orgWide: false, userIds: [...ids] }
}

async function loadVisible(tx: RlsClient, orgId: string, companyId: string): Promise<Company> {
  if (!UUID_RE.test(companyId)) throw notFound()
  const [row] = await tx
    .select()
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.orgId, orgId)))
    .limit(1)
  if (!row) throw notFound()
  return row
}

/**
 * As loadVisible, but a company merged into one the caller sees answers 404
 * naming the survivor (a colleague's tab still open on the merged company).
 */
async function loadVisibleOrMerged(
  tx: RlsClient,
  orgId: string,
  companyId: string,
): Promise<Company> {
  try {
    return await loadVisible(tx, orgId, companyId)
  } catch (err) {
    if (!(err instanceof HTTPException) || err.status !== 404) throw err
    const survivor = await companyMergedInto(tx, orgId, companyId)
    throw survivor ? new CompanyMergedError(survivor) : err
  }
}

/** People the caller sees per company, by company id. */
async function peopleCounts(
  tx: RlsClient,
  orgId: string,
  ids: string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const rows = extractRows<{ company_id: string; n: number }>(
    await tx.execute(drizzleSql`
      SELECT company_id::text AS company_id, count(*)::int AS n
        FROM ${ks()}.contacts
       WHERE org_id = ${orgId}::uuid AND company_id = ANY(${`{${ids.join(",")}}`}::uuid[])
       GROUP BY company_id`),
  )
  return new Map(rows.map((r) => [r.company_id, r.n]))
}

/**
 * The newest open deal of each company, as far as the caller's RLS lets them
 * see deals (projects read) and amounts (deal access). Nothing when the
 * projects app's tables are absent.
 */
async function openDeals(
  tx: RlsClient,
  orgId: string,
  ids: string[],
): Promise<Map<string, CompanyDealSummary>> {
  if (ids.length === 0 || !(await dealTablesExist(tx))) return new Map()
  const rows = extractRows<{
    company_id: string
    task_id: string
    title: string
    project_id: string
    stage: string | null
    amount_minor: string | number | null
    currency: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT DISTINCT ON (d.company_id)
             d.company_id::text AS company_id, d.task_id::text AS task_id,
             t.title, t.project_id::text AS project_id,
             s.label AS stage, v.amount_minor, v.currency
        FROM ${ps()}.deals d
        JOIN ${ps()}.tasks t ON t.id = d.task_id AND t.archived_at IS NULL AND t.parent_task_id IS NULL
        LEFT JOIN ${ps()}.project_statuses s ON s.id = t.status_id
        LEFT JOIN ${ps()}.deal_values v ON v.task_id = d.task_id
       WHERE d.org_id = ${orgId}::uuid AND d.outcome = 'open'
         AND d.company_id = ANY(${`{${ids.join(",")}}`}::uuid[])
       ORDER BY d.company_id, d.created_at DESC, d.task_id`),
  )
  return new Map(
    rows.map((r) => [
      r.company_id,
      {
        taskId: r.task_id,
        title: r.title,
        projectId: r.project_id,
        stage: r.stage,
        amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
        currency: r.currency,
      },
    ]),
  )
}

async function withSummaries(tx: RlsClient, orgId: string, rows: Company[]): Promise<CompanyRow[]> {
  const ids = rows.map((r) => r.id)
  const [counts, deals] = [await peopleCounts(tx, orgId, ids), await openDeals(tx, orgId, ids)]
  return rows.map((r) => ({
    ...r,
    peopleCount: counts.get(r.id) ?? 0,
    openDeal: deals.get(r.id) ?? null,
  }))
}

/** One company the caller sees, with its summary; null when it is not visible. */
export async function getCompany(
  tx: RlsClient,
  params: { orgId: string; companyId: string },
): Promise<CompanyRow | null> {
  if (!UUID_RE.test(params.companyId)) return null
  const [row] = await tx
    .select()
    .from(companies)
    .where(and(eq(companies.id, params.companyId), eq(companies.orgId, params.orgId)))
    .limit(1)
  if (!row) return null
  return (await withSummaries(tx, params.orgId, [row]))[0] ?? null
}

/**
 * The companies the caller sees, most recently changed first, filtered by a
 * name or domain fragment. A personal mail domain matches nothing: no company
 * holds one.
 */
export async function listCompanies(
  tx: RlsClient,
  params: {
    orgId: string
    page: number
    limit: number
    query?: string
    tag?: string
    /** Only the companies this person manages. */
    ownerUserId?: string
    /** Only companies with (true) or without (false) an open deal the caller sees. */
    hasOpenDeal?: boolean
  },
): Promise<{ rows: CompanyRow[]; total: number }> {
  const { orgId, page, limit } = params
  const conditions = [eq(companies.orgId, orgId)]
  if (params.tag?.trim()) conditions.push(drizzleSql`${params.tag.trim()} = ANY(${companies.tags})`)
  if (params.ownerUserId !== undefined) {
    if (!UUID_RE.test(params.ownerUserId)) return { rows: [], total: 0 }
    conditions.push(eq(companies.ownerUserId, params.ownerUserId))
  }
  if (params.hasOpenDeal !== undefined) {
    const open = (await dealTablesExist(tx))
      ? drizzleSql`EXISTS (
          SELECT 1 FROM ${ps()}.deals d JOIN ${ps()}.tasks t ON t.id = d.task_id AND t.archived_at IS NULL AND t.parent_task_id IS NULL
           WHERE d.org_id = ${orgId}::uuid AND d.company_id = ${drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}.companies.id`)} AND d.outcome = 'open')`
      : drizzleSql`false`
    conditions.push(params.hasOpenDeal ? open : drizzleSql`NOT ${open}`)
  }
  const q = params.query?.trim()
  if (q) {
    const asDomain = q
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
    if (isConsumerMailDomain(asDomain)) return { rows: [], total: 0 }
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    conditions.push(
      drizzleSql`(${companies.name} ILIKE ${like} OR ${companies.domain} ILIKE ${like})`,
    )
  }
  const rows = await tx
    .select({ company: companies, total: drizzleSql<number>`COUNT(*) OVER()::int` })
    .from(companies)
    .where(and(...conditions))
    .orderBy(drizzleSql`${companies.updatedAt} DESC`, companies.id)
    .limit(limit)
    .offset((page - 1) * limit)
  const total = rows[0]?.total ?? 0
  return {
    rows: await withSummaries(
      tx,
      orgId,
      rows.map((r) => r.company),
    ),
    total,
  }
}

/** Pending approvals at most one company page lists in its Waiting section. */
export const COMPANY_WAITING_MAX = 50

/**
 * The pending approvals the caller sees whose summary links name this
 * company, one of its people or one of its deals, newest first. Null when the
 * company is not visible to the caller (the page answers 404).
 */
export async function companyWaitingApprovalIds(
  tx: RlsClient,
  params: { orgId: string; companyId: string },
): Promise<string[] | null> {
  const { orgId, companyId } = params
  if (!UUID_RE.test(companyId)) return null
  const [visible] = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.orgId, orgId)))
    .limit(1)
  if (!visible) return null
  const people = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.companyId, companyId)))
  const deals = (await dealTablesExist(tx))
    ? extractRows<{ task_id: string }>(
        await tx.execute(drizzleSql`
          SELECT task_id::text AS task_id FROM ${ps()}.deals
           WHERE org_id = ${orgId}::uuid AND company_id = ${companyId}::uuid`),
      )
    : []
  const ids = [companyId, ...people.map((p) => p.id), ...deals.map((d) => d.task_id)]
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT a.id::text AS id
        FROM ${ks()}.approval_requests a
       WHERE a.org_id = ${orgId}::uuid AND a.status = 'pending'
         AND jsonb_typeof(a.summary -> 'links') = 'array'
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(a.summary -> 'links') l
            WHERE l ->> 'entityId' = ANY(${`{${ids.join(",")}}`}::text[]))
       ORDER BY a.created_at DESC, a.id
       LIMIT ${COMPANY_WAITING_MAX}`),
  )
  return rows.map((r) => r.id)
}

export interface SimilarCompany {
  id: string
  name: string
  domain: string | null
  reason: "same_name" | "same_domain"
}

/**
 * Companies the caller sees that look like the one being typed: the same name
 * once case, accents and legal forms are set aside, or the same business
 * domain. A hint for the create form ("Looks like Maison Arlon"), never a
 * refusal.
 */
export async function similarCompanies(
  tx: RlsClient,
  params: { orgId: string; name?: string; domain?: string; excludeId?: string },
): Promise<SimilarCompany[]> {
  const key = companyNameKey(params.name)
  let domain: string | null = null
  if (params.domain?.trim()) {
    try {
      const d = normaliseCompanyDomain(params.domain)
      domain = d.domain
    } catch {
      domain = null
    }
  }
  if (!key && !domain) return []
  const firstWord = key.split(" ")[0] ?? ""
  const nameLike = firstWord ? `%${firstWord.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null
  const rows = extractRows<{ id: string; name: string; domain: string | null }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, name, domain FROM ${ks()}.companies
       WHERE org_id = ${params.orgId}::uuid
         AND (${nameLike !== null ? drizzleSql`name ILIKE ${nameLike}` : drizzleSql`false`}
              OR ${domain !== null ? drizzleSql`lower(domain) = ${domain}` : drizzleSql`false`})
       ORDER BY updated_at DESC
       LIMIT 200`),
  )
  const out: SimilarCompany[] = []
  for (const r of rows) {
    if (r.id === params.excludeId) continue
    if (key && companyNameKey(r.name) === key) out.push({ ...r, reason: "same_name" })
    else if (domain && r.domain?.toLowerCase() === domain) out.push({ ...r, reason: "same_domain" })
    if (out.length >= 5) break
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create a company, org-wide by default, with the caller as its creator (the
 * sharing trigger stamps `created_by` from the transaction's actor).
 */
export async function createCompany(
  tx: RlsClient,
  params: { orgId: string; userId: string; input: CompanyInput },
): Promise<CompanyWrite> {
  const { orgId, userId, input } = params
  const name = cleanName(input.name)
  const d = normaliseCompanyDomain(input.domain)
  const base = handleBase(name)
  let created: Company | undefined
  for (let attempt = 1; attempt <= 50 && !created; attempt++) {
    const handle =
      attempt === 1
        ? base
        : attempt < 50
          ? `${base}-${attempt}`
          : `${base}-${crypto.randomUUID().slice(0, 8)}`
    const [row] = await tx
      .insert(companies)
      .values({
        orgId,
        handle,
        name,
        domain: d.domain,
        description: input.description?.trim() || null,
        ...(cleanTags(input.tags)?.length ? { tags: cleanTags(input.tags) } : {}),
        createdBy: actorUuid(userId),
      })
      .onConflictDoNothing({ target: [companies.orgId, companies.handle] })
      .returning()
    created = row
  }
  if (!created) {
    throw new CompanyRequestError(409, "handle_taken", "Could not give the company a free handle.")
  }
  log.info({ companyId: created.id, handle: created.handle }, "Company created")
  await tx.queueEvent({
    app: "kernel",
    entity: "company",
    action: "create",
    orgId,
    actorId: userId,
    entityId: created.id,
    data: {
      id: created.id,
      name: created.name,
      handle: created.handle,
      domain: created.domain,
      audience: companyEventAudience(created),
    },
  })
  return {
    company: created,
    ...("refused" in d ? { notice: consumerDomainNotice(d.typed) } : {}),
  }
}

/**
 * Many companies at once, for an import or a seed: one multi-row insert and one
 * batch of `company:create` events, the same rows and events `createCompany`
 * writes one by one. A company whose handle is already taken (by an older
 * company or by an earlier one of the batch) goes through `createCompany`,
 * which numbers it. Returns each created company in input order.
 */
export async function createCompanies(
  tx: RlsClient,
  params: { orgId: string; userId: string; inputs: readonly CompanyInput[] },
): Promise<Company[]> {
  const { orgId, userId, inputs } = params
  if (inputs.length === 0) return []
  const values = inputs.map((input) => {
    const name = cleanName(input.name)
    const tags = cleanTags(input.tags)
    return {
      orgId,
      handle: handleBase(name),
      name,
      domain: normaliseCompanyDomain(input.domain).domain,
      description: input.description?.trim() || null,
      ...(tags?.length ? { tags } : {}),
      createdBy: actorUuid(userId),
    }
  })
  const inserted = await tx
    .insert(companies)
    .values(values)
    .onConflictDoNothing({ target: [companies.orgId, companies.handle] })
    .returning()
  const byHandle = new Map(inserted.map((c) => [c.handle, c]))
  const out: Company[] = []
  for (const [i, v] of values.entries()) {
    const row = byHandle.get(v.handle)
    if (row && row.name === v.name) {
      byHandle.delete(v.handle)
      out.push(row)
    } else {
      // Its handle went to another company: numbered one at a time, with its own event.
      out.push(
        (await createCompany(tx, { orgId, userId, input: inputs[i] as CompanyInput })).company,
      )
    }
  }
  await tx.queueEvents(
    inserted.map((created) => ({
      app: "kernel",
      entity: "company",
      action: "create",
      orgId,
      actorId: userId,
      entityId: created.id,
      data: {
        id: created.id,
        name: created.name,
        handle: created.handle,
        domain: created.domain,
        audience: companyEventAudience(created),
      },
    })),
  )
  log.info({ orgId, count: out.length }, "Companies created")
  return out
}

/**
 * Change a company. A rename rewrites the company name carried by every linked
 * person in the same transaction (elevated: a private person's row is not the
 * renamer's to edit under RLS, but the name it carries is the company's).
 * Closing it stamps `closed_at` and announces `company:closed`.
 */
export async function updateCompany(
  db: RlsClient,
  params: { orgId: string; userId: string; companyId: string; patch: CompanyPatch },
): Promise<CompanyWrite> {
  const { orgId, userId, companyId, patch } = params
  return withElevatableRlsFrom(db, "company-update", async (tx) => {
    const before = await loadVisibleOrMerged(tx, orgId, companyId)
    const set: Record<string, unknown> = { updatedAt: new Date() }
    let notice: string | undefined
    if (patch.name !== undefined) set.name = cleanName(patch.name)
    if (patch.domain !== undefined) {
      const d = normaliseCompanyDomain(patch.domain)
      set.domain = d.domain
      if ("refused" in d) notice = consumerDomainNotice(d.typed)
    }
    if (patch.description !== undefined) set.description = patch.description?.trim() || null
    if (patch.tags !== undefined) set.tags = cleanTags(patch.tags) ?? []
    if (patch.metadata !== undefined) set.metadata = patch.metadata
    if (patch.mainContactId !== undefined) {
      if (patch.mainContactId !== null) {
        const [person] = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.orgId, orgId),
              eq(contacts.companyId, companyId),
              drizzleSql`${contacts.id} = ${UUID_RE.test(patch.mainContactId) ? patch.mainContactId : null}::uuid`,
            ),
          )
          .limit(1)
        if (!person) {
          throw new CompanyRequestError(
            422,
            "main_contact_not_linked",
            `The main contact must be one of ${before.name}'s people. Link the person to the company first.`,
          )
        }
      }
      set.mainContactId = patch.mainContactId
    }
    const closing = patch.closed === true && before.closedAt === null
    if (patch.closed === true && before.closedAt === null) set.closedAt = new Date()
    if (patch.closed === false) set.closedAt = null

    const [updated] = await tx
      .update(companies)
      .set(set)
      .where(and(eq(companies.id, companyId), eq(companies.orgId, orgId)))
      .returning()
    // Visible but not editable (a viewer): the UPDATE policy matched nothing.
    if (!updated) {
      throw new HTTPException(403, { message: "You can see this company but not change it." })
    }

    let renamed = 0
    if (updated.name !== before.name) {
      await tx.transaction((sp) =>
        asAdmin(sp, async () => {
          await sp.execute(drizzleSql`
            UPDATE ${ks()}.contacts SET company = ${updated.name}, updated_at = now()
             WHERE org_id = ${orgId}::uuid AND company_id = ${companyId}::uuid`)
          await runAfterCompanyRenameFailpoint()
        }),
      )
      // The event says how many people the renamer can see were renamed, never
      // the people hidden from them.
      const [visible] = extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM ${ks()}.contacts
           WHERE org_id = ${orgId}::uuid AND company_id = ${companyId}::uuid`),
      )
      renamed = visible?.n ?? 0
    }

    await tx.queueEvent({
      app: "kernel",
      entity: "company",
      action: "update",
      orgId,
      actorId: userId,
      entityId: companyId,
      data: { ...updated, renamedPeople: renamed, audience: companyEventAudience(updated) },
    })
    if (closing) {
      await tx.queueEvent({
        app: "kernel",
        entity: "company",
        action: "closed",
        orgId,
        actorId: userId,
        entityId: companyId,
        data: { id: companyId, name: updated.name, audience: companyEventAudience(updated) },
      })
    }
    return { company: updated, ...(notice ? { notice } : {}) }
  })
}

/**
 * Delete a company. In the same transaction its deals and pipelines stop
 * naming it (elevated: the deleter may not see every deal), its discussion
 * goes, and the grant rows go by the table's cleanup trigger. People keep
 * their company text and lose the link (the foreign key sets it NULL). A
 * company a portal account belongs to is refused (409 `company_has_accounts`), and so is one a
 * recurring invoice schedule not ended still bills (409 `company_has_schedules`). Ended schedules
 * and billing customers mirrored from the payment connector let go of it (the column is cleared).
 */
export async function deleteCompany(
  db: RlsClient,
  params: { orgId: string; userId: string; companyId: string },
): Promise<{ id: string; dealsCleared: number; projectsCleared: number }> {
  const { orgId, userId, companyId } = params
  return withElevatableRlsFrom(db, "company-delete", async (tx) => {
    const company = await loadVisible(tx, orgId, companyId)
    // A live recurring schedule bills this company: deleting it would leave the schedule
    // billing nobody. Counted past the caller's row security, so the refusal does not depend
    // on whether the caller can read invoicing.
    const billing = await tx.transaction((sp) =>
      asAdmin(sp, () => liveSchedulesBilling(sp, { orgId, companyId })),
    )
    if (billing > 0) {
      throw new CompanyRequestError(
        409,
        "company_has_schedules",
        `${company.name} is billed by ${billing} recurring invoice schedule${billing === 1 ? "" : "s"}, so it cannot be deleted. End those schedules or bill another company first.`,
      )
    }
    let deleted: { id: string } | undefined
    try {
      deleted = await tx.transaction(async (sp) => {
        const [row] = await sp
          .delete(companies)
          .where(and(eq(companies.id, companyId), eq(companies.orgId, orgId)))
          .returning({ id: companies.id })
        return row
      })
    } catch (err) {
      if (pgCode(err) === "23503") {
        throw new CompanyRequestError(
          409,
          "company_has_accounts",
          `${company.name} has portal accounts, so it cannot be deleted. Remove or move those accounts first.`,
        )
      }
      throw err
    }
    if (!deleted) {
      throw new HTTPException(403, { message: "You can see this company but not delete it." })
    }

    const cleared = await tx.transaction((sp) =>
      asAdmin(sp, async () => {
        if (!(await dealTablesExist(sp))) return { deals: 0, projects: 0 }
        const deals = extractRows(
          await sp.execute(drizzleSql`
            UPDATE ${ps()}.deals SET company_id = NULL, updated_at = now()
             WHERE org_id = ${orgId}::uuid AND company_id = ${companyId}::uuid
             RETURNING task_id`),
        ).length
        const projects = extractRows(
          await sp.execute(drizzleSql`
            UPDATE ${ps()}.projects SET company_id = NULL
             WHERE org_id = ${orgId}::uuid AND company_id = ${companyId}::uuid
             RETURNING id`),
        ).length
        return { deals, projects }
      }),
    )
    await tx.transaction((sp) => asAdmin(sp, () => unlinkAppCompanyRows(sp, { orgId, companyId })))
    await tx.transaction((sp) =>
      asAdmin(sp, () =>
        deleteEntityDiscussions(
          { orgId, app: "kernel", entityType: "company", entityIds: [companyId] },
          sp as never,
        ),
      ),
    )

    await tx.queueEvent({
      app: "kernel",
      entity: "company",
      action: "delete",
      orgId,
      actorId: userId,
      entityId: companyId,
      // The page's handler reads `data.id` to drop the row.
      data: { id: companyId, audience: companyEventAudience(company) },
    })
    return { id: companyId, dealsCleared: cleared.deals, projectsCleared: cleared.projects }
  })
}

/**
 * Link people to a company: each one's `company_id` and its `company` text
 * (the company's name) are written together. People the caller cannot see or
 * edit are skipped and named by id.
 */
export async function linkContactsToCompany(
  tx: RlsClient,
  params: { orgId: string; userId: string; companyId: string; contactIds: string[] },
): Promise<{ companyId: string; linked: string[]; skipped: string[] }> {
  const { orgId, userId, companyId } = params
  const ids = [...new Set(params.contactIds)]
  if (ids.length > COMPANY_LINK_BATCH_MAX) {
    throw new CompanyRequestError(
      422,
      "too_many_people",
      `Link at most ${COMPANY_LINK_BATCH_MAX} people at once.`,
    )
  }
  const company = await loadVisible(tx, orgId, companyId)
  const idList = drizzleSql`${contacts.id} = ANY(${`{${ids.filter((i) => UUID_RE.test(i)).join(",")}}`}::uuid[])`
  // People already linked to this company under its name are linked: nothing is
  // written for them and no event says they changed.
  const already = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.orgId, orgId),
        idList,
        eq(contacts.companyId, company.id),
        eq(contacts.company, company.name),
      ),
    )
  const unchanged = new Set(already.map((r) => r.id))
  const updated = await tx
    .update(contacts)
    .set({ companyId: company.id, company: company.name, updatedAt: new Date() })
    .where(
      and(
        eq(contacts.orgId, orgId),
        idList,
        drizzleSql`(${contacts.companyId} IS DISTINCT FROM ${company.id}::uuid OR ${contacts.company} IS DISTINCT FROM ${company.name})`,
      ),
    )
    .returning()
  for (const row of updated) {
    await tx.queueEvent({
      app: "kernel",
      entity: "contact",
      action: "update",
      entityId: row.id,
      orgId,
      actorId: userId,
      data: row,
    })
  }
  const linked = new Set([...unchanged, ...updated.map((r) => r.id)])
  return {
    companyId,
    linked: ids.filter((i) => linked.has(i)),
    skipped: ids.filter((i) => !linked.has(i)),
  }
}

/**
 * Unlink people from a company: the link and the company name they carried
 * both go. People not linked to it, or not the caller's to edit, are skipped.
 */
export async function unlinkContactsFromCompany(
  tx: RlsClient,
  params: { orgId: string; userId: string; companyId: string; contactIds: string[] },
): Promise<{ companyId: string; unlinked: string[]; skipped: string[] }> {
  const { orgId, userId, companyId } = params
  const ids = [...new Set(params.contactIds)].filter((i) => UUID_RE.test(i))
  if (ids.length > COMPANY_LINK_BATCH_MAX) {
    throw new CompanyRequestError(
      422,
      "too_many_people",
      `Unlink at most ${COMPANY_LINK_BATCH_MAX} people at once.`,
    )
  }
  await loadVisible(tx, orgId, companyId)
  const updated = await tx
    .update(contacts)
    .set({ companyId: null, company: null, updatedAt: new Date() })
    .where(
      and(
        eq(contacts.orgId, orgId),
        eq(contacts.companyId, companyId),
        drizzleSql`${contacts.id} = ANY(${`{${ids.join(",")}}`}::uuid[])`,
      ),
    )
    .returning()
  for (const row of updated) {
    await tx.queueEvent({
      app: "kernel",
      entity: "contact",
      action: "update",
      entityId: row.id,
      orgId,
      actorId: userId,
      data: row,
    })
  }
  const done = new Set(updated.map((r) => r.id))
  return { companyId, unlinked: [...done], skipped: params.contactIds.filter((i) => !done.has(i)) }
}

/* -------------------------------------------------------------------------- */
/* Account manager                                                            */
/* -------------------------------------------------------------------------- */

export type ManagerRefusalCode =
  | "manager_not_found"
  | "manager_inactive"
  | "manager_external"
  | "manager_cannot_see_company"

export interface CompanyRef {
  id: string
  name: string
}

export interface ManagerSkip extends CompanyRef {
  code: ManagerRefusalCode | "not_found" | "not_editable"
  reason: string
}

export interface ManagerChange extends CompanyRef {
  previousOwnerUserId: string | null
}

export interface SetManagerResult {
  manager: { id: string; name: string } | null
  moved: ManagerChange[]
  skipped: ManagerSkip[]
}

/** Company ids among `ids` that `personId` may read: org-visible, created by them, or granted. */
async function companiesPersonCanRead(
  orgId: string,
  personId: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  return withPrivilegedDb(orgId, "company-manager-visibility", async (tx) => {
    const rows = extractRows<{ id: string; org_access: string; created_by: string | null }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id, org_access, created_by::text AS created_by
          FROM ${ks()}.companies
         WHERE org_id = ${orgId}::uuid AND id = ANY(${`{${ids.join(",")}}`}::uuid[])`),
    )
    const roles = (
      await tx
        .select({ roleId: userRoles.roleId })
        .from(userRoles)
        .where(and(eq(userRoles.orgId, orgId), eq(userRoles.userId, personId)))
    ).map((r) => r.roleId)
    const out = new Set<string>()
    for (const r of rows) {
      if (r.org_access !== "none" || r.created_by === personId) out.add(r.id)
      else if (await actorGrantRole(tx, COMPANY_RESOURCE, r.id, { userId: personId, roles })) {
        out.add(r.id)
      }
    }
    return out
  })
}

/** The person named as account manager, or why they cannot be one. */
async function managerCandidate(
  orgId: string,
  personId: string,
): Promise<{ id: string; name: string } | { code: ManagerRefusalCode; reason: string }> {
  const [row] = UUID_RE.test(personId)
    ? await withPrivilegedDb(orgId, "company-manager-person", (tx) =>
        tx
          .select({ id: users.id, name: users.name, status: users.status, type: users.userType })
          .from(users)
          .where(and(eq(users.id, personId), eq(users.orgId, orgId)))
          .limit(1),
      )
    : []
  if (!row) {
    return {
      code: "manager_not_found",
      reason: `No member of this organisation has the id ${personId}. Find them with kernel__users_search.`,
    }
  }
  const name = row.name ?? "This person"
  if (row.type !== "member") {
    return {
      code: "manager_external",
      reason: `${name} is an outside account, and an account manager is a member of the organisation.`,
    }
  }
  if (row.status !== "active") {
    return {
      code: "manager_inactive",
      reason: `${name} is not an active member, so cannot manage accounts.`,
    }
  }
  return { id: row.id, name: row.name ?? row.id }
}

/** Why `personId` cannot be an account manager at all, or null when they can. */
export async function managerRefusal(
  orgId: string,
  personId: string,
): Promise<{ code: ManagerRefusalCode; reason: string } | null> {
  const who = await managerCandidate(orgId, personId)
  return "code" in who ? who : null
}

/**
 * The ids among `ids` that name no company the requester may know (stage-time
 * checks of a gated call): org-visible, created by them, or granted. Existence
 * only: visibility at execution stays the approver's RLS decision.
 */
export async function companyIdsUnknownTo(
  requester: {
    orgId: string
    userId?: string
    roles?: string[]
    dimensionGrants?: Record<string, string[]>
  },
  ids: string[],
): Promise<string[]> {
  const valid = [...new Set(ids)].filter((i) => UUID_RE.test(i))
  if (valid.length === 0) return ids.filter((i) => !UUID_RE.test(i))
  const known = await withPrivilegedDb(requester.orgId, "company-preflight", async (tx) => {
    const rows = extractRows<{ id: string; org_access: string; created_by: string | null }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id, org_access, created_by::text AS created_by
          FROM ${ks()}.companies
         WHERE org_id = ${requester.orgId}::uuid AND id = ANY(${`{${valid.join(",")}}`}::uuid[])`),
    )
    const out = new Set<string>()
    for (const r of rows) {
      if (r.org_access !== "none" || (requester.userId && r.created_by === requester.userId)) {
        out.add(r.id)
      } else if (
        requester.userId &&
        (await actorGrantRole(tx, COMPANY_RESOURCE, r.id, {
          userId: requester.userId,
          roles: requester.roles,
          dimensionGrants: requester.dimensionGrants,
        }))
      ) {
        out.add(r.id)
      }
    }
    return out
  })
  return ids.filter((i) => !known.has(i))
}

/**
 * Give companies to one account manager (or clear it with null), in one
 * transaction. The manager must be an active member of the organisation who
 * can already read each company: nothing is shared as a side effect, and a
 * company they cannot read is skipped with "Share the company with them
 * first". Companies the caller cannot see or change are skipped too; the rest
 * apply. Each change announces `company:update` with the old and the new
 * manager.
 */
export async function setCompanyManager(
  db: RlsClient,
  params: { orgId: string; userId: string; companyIds: string[]; ownerUserId: string | null },
): Promise<SetManagerResult> {
  const { orgId, userId, ownerUserId } = params
  const ids = [...new Set(params.companyIds)].filter((i) => UUID_RE.test(i))
  if (ids.length > COMPANY_LINK_BATCH_MAX) {
    throw new CompanyRequestError(
      422,
      "too_many_companies",
      `Give at most ${COMPANY_LINK_BATCH_MAX} companies at once.`,
    )
  }
  // The tool call or request runs in one transaction: every change below commits together.
  const tx = db
  const visible = await tx
    .select({
      id: companies.id,
      name: companies.name,
      ownerUserId: companies.ownerUserId,
      orgAccess: companies.orgAccess,
      createdBy: companies.createdBy,
      aclUserIds: companies.aclUserIds,
    })
    .from(companies)
    .where(
      and(
        eq(companies.orgId, orgId),
        drizzleSql`${companies.id} = ANY(${`{${ids.join(",")}}`}::uuid[])`,
      ),
    )
  const byId = new Map(visible.map((c) => [c.id, c]))
  const skipped: ManagerSkip[] = params.companyIds
    .filter((id) => !byId.has(id))
    .map((id) => ({
      id,
      name: id,
      code: "not_found",
      reason: "No company you can see has this id.",
    }))

  let manager: { id: string; name: string } | null = null
  let readable = new Set(visible.map((c) => c.id))
  if (ownerUserId !== null) {
    const who = await managerCandidate(orgId, ownerUserId)
    if ("code" in who) {
      return {
        manager: null,
        moved: [],
        skipped: [...visible.map((c) => ({ id: c.id, name: c.name, ...who })), ...skipped],
      }
    }
    manager = who
    readable = await companiesPersonCanRead(
      orgId,
      who.id,
      visible.map((c) => c.id),
    )
  }

  const moved: ManagerChange[] = []
  for (const c of visible) {
    if (!readable.has(c.id)) {
      skipped.push({
        id: c.id,
        name: c.name,
        code: "manager_cannot_see_company",
        reason: `${manager?.name ?? "They"} cannot see ${c.name}. Share the company with them first.`,
      })
      continue
    }
    if (c.ownerUserId === ownerUserId) {
      moved.push({ id: c.id, name: c.name, previousOwnerUserId: c.ownerUserId })
      continue
    }
    const [row] = await tx
      .update(companies)
      .set({ ownerUserId, updatedAt: new Date() })
      .where(and(eq(companies.id, c.id), eq(companies.orgId, orgId)))
      .returning({ id: companies.id })
    if (!row) {
      skipped.push({
        id: c.id,
        name: c.name,
        code: "not_editable",
        reason: `You can see ${c.name} but not change it.`,
      })
      continue
    }
    moved.push({ id: c.id, name: c.name, previousOwnerUserId: c.ownerUserId })
    await tx.queueEvent({
      app: "kernel",
      entity: "company",
      action: "update",
      orgId,
      actorId: userId,
      entityId: c.id,
      data: {
        id: c.id,
        name: c.name,
        ownerUserId,
        previousOwnerUserId: c.ownerUserId,
        audience: companyEventAudience(c),
      },
    })
  }
  return { manager, moved, skipped }
}

/** The account manager of a company with their away state, for a reader of the company. */
export async function companyAccountManager(
  orgId: string,
  ownerUserId: string | null,
  now: Date = new Date(),
): Promise<{
  id: string
  name: string
  away: { until: string; nextInLine: { id: string; name: string } | null } | null
} | null> {
  if (!ownerUserId) return null
  const { readAwayToday } = await import("~/modules/users/away")
  const away = (await readAwayToday(orgId, [ownerUserId], now)).get(ownerUserId)
  const ids = [ownerUserId, ...(away?.nextInLineId ? [away.nextInLineId] : [])]
  const people = await withPrivilegedDb(orgId, "company-manager-names", (tx) =>
    tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(
        and(eq(users.orgId, orgId), drizzleSql`${users.id} = ANY(${`{${ids.join(",")}}`}::uuid[])`),
      ),
  )
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? id
  return {
    id: ownerUserId,
    name: name(ownerUserId),
    away: away
      ? {
          until: away.until,
          nextInLine: away.nextInLineId
            ? { id: away.nextInLineId, name: name(away.nextInLineId) }
            : null,
        }
      : null,
  }
}

/** Display names of members by id (account managers on a list). */
export async function memberNames(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter((i) => UUID_RE.test(i))
  if (unique.length === 0) return new Map()
  const rows = await withPrivilegedDb(orgId, "company-manager-names", (tx) =>
    tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(
        and(
          eq(users.orgId, orgId),
          drizzleSql`${users.id} = ANY(${`{${unique.join(",")}}`}::uuid[])`,
        ),
      ),
  )
  return new Map(rows.map((r) => [r.id, r.name ?? r.id]))
}

/* -------------------------------------------------------------------------- */
/* Duplicates and "not the same"                                              */
/* -------------------------------------------------------------------------- */

export const COMPANY_DUPLICATE_SCAN_CAP = 2000

export interface CompanyCluster {
  ids: string[]
  names: string[]
  signal: "same_domain" | "same_name" | "same_name_and_domain"
  confidence: "high" | "needs_confirmation"
}

/**
 * Pairs of companies the caller sees that look like one: the same business
 * domain, the same name once case, accents and legal forms are set aside, or
 * both. A pair marked "not the same" is never returned.
 */
export async function findCompanyDuplicates(
  tx: RlsClient,
  params: { orgId: string },
): Promise<{ clusters: CompanyCluster[]; scannedCount: number; coveragePartial: boolean }> {
  const rows = await tx
    .select({
      id: companies.id,
      name: companies.name,
      domain: companies.domain,
      notSameAs: companies.notSameAs,
    })
    .from(companies)
    .where(eq(companies.orgId, params.orgId))
    .orderBy(companies.createdAt, companies.id)
    .limit(COMPANY_DUPLICATE_SCAN_CAP + 1)
  const scanned = rows.slice(0, COMPANY_DUPLICATE_SCAN_CAP)
  const pairs = new Map<string, CompanyCluster>()
  const group = (
    key: (r: (typeof scanned)[number]) => string | null,
    signal: "domain" | "name",
  ) => {
    const by = new Map<string, typeof scanned>()
    for (const r of scanned) {
      const k = key(r)
      if (!k) continue
      by.set(k, [...(by.get(k) ?? []), r])
    }
    for (const members of by.values()) {
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const a = members[i]!
          const b = members[j]!
          if (a.notSameAs.includes(b.id) || b.notSameAs.includes(a.id)) continue
          const [x, y] = a.id < b.id ? [a, b] : [b, a]
          const pairKey = `${x.id}:${y.id}`
          const prev = pairs.get(pairKey)
          const sig = signal === "domain" ? "same_domain" : "same_name"
          pairs.set(pairKey, {
            ids: [x.id, y.id],
            names: [x.name, y.name],
            signal: prev && prev.signal !== sig ? "same_name_and_domain" : sig,
            confidence: prev && prev.signal !== sig ? "high" : "needs_confirmation",
          })
        }
      }
    }
  }
  group((r) => r.domain?.toLowerCase() ?? null, "domain")
  group((r) => companyNameKey(r.name) || null, "name")
  const clusters = [...pairs.values()].sort((a, b) =>
    a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1,
  )
  return {
    clusters,
    scannedCount: scanned.length,
    coveragePartial: rows.length > COMPANY_DUPLICATE_SCAN_CAP,
  }
}

/**
 * Record that two companies are not the same (each id goes into the other's
 * `not_same_as`), or undo it. Both must be companies the caller sees.
 */
export async function markCompaniesNotSame(
  db: RlsClient,
  params: { orgId: string; userId: string; aId: string; bId: string; undo?: boolean },
): Promise<{ a: CompanyRef; b: CompanyRef; notSame: boolean }> {
  const { orgId, aId, bId } = params
  if (aId === bId) {
    throw new CompanyRequestError(422, "same_company", "A company is always the same as itself.")
  }
  // The tool call or request runs in one transaction: every change below commits together.
  const tx = db
  const a = await loadVisible(tx, orgId, aId)
  const b = await loadVisible(tx, orgId, bId)
  for (const [self, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const next = params.undo
      ? self.notSameAs.filter((id) => id !== other.id)
      : [...new Set([...self.notSameAs, other.id])]
    const [row] = await tx
      .update(companies)
      .set({ notSameAs: next, updatedAt: new Date() })
      .where(and(eq(companies.id, self.id), eq(companies.orgId, orgId)))
      .returning({ id: companies.id })
    if (!row) {
      throw new HTTPException(403, { message: `You can see ${self.name} but not change it.` })
    }
  }
  return {
    a: { id: a.id, name: a.name },
    b: { id: b.id, name: b.name },
    notSame: !params.undo,
  }
}

/* -------------------------------------------------------------------------- */
/* Merge                                                                      */
/* -------------------------------------------------------------------------- */

/** Where a merge can be made to fail in a test: after the waiting items moved, or at the end. */
export type CompanyMergeStage = "after-routes" | "after-references"

export interface CompanyMergeResult {
  source: CompanyRef
  target: CompanyRef
  /** The survivor's account manager after the merge. */
  managerId: string | null
  /** Whose manager the survivor keeps. */
  managerFrom: "target" | "source" | "none"
  moved: {
    contacts: number
    accounts: number
    waitingApprovals: number
    deals: number
    projects: number
  }
  discussionMoved: boolean
}

/** A request about a company that was merged away: 404, naming the survivor. */
export class CompanyMergedError extends HTTPException {
  readonly code = "company_merged"
  readonly errorFields: { mergedInto: CompanyRef }
  constructor(readonly mergedInto: CompanyRef) {
    super(404, { message: `This company was merged into ${mergedInto.name}.` })
    this.errorFields = { mergedInto }
  }
}

/**
 * The company `companyId` was merged into, when the caller can see it, else
 * null. Read from the audit row of the source's deletion, which names the
 * survivor (`mergedInto`), and the survivor under the caller's RLS.
 */
export async function companyMergedInto(
  tx: RlsClient,
  orgId: string,
  companyId: string,
): Promise<CompanyRef | null> {
  if (!UUID_RE.test(companyId)) return null
  const survivorId = await withPrivilegedDb(orgId, "company-merged-into", async (ptx) => {
    const [row] = extractRows<{ id: string | null }>(
      await ptx.execute(drizzleSql`
        SELECT changes->>'mergedInto' AS id FROM ${ks()}.audit_log
         WHERE org_id = ${orgId}::uuid AND entity_type = 'company' AND entity_id = ${companyId}
           AND action = 'company.delete' AND changes ? 'mergedInto'
         ORDER BY timestamp DESC LIMIT 1`),
    )
    return row?.id ?? null
  })
  if (!survivorId || !UUID_RE.test(survivorId)) return null
  const [survivor] = await tx
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.id, survivorId), eq(companies.orgId, orgId)))
    .limit(1)
  return survivor ?? null
}

const ORG_ACCESS_RANK: Record<string, number> = { none: 0, viewer: 1, editor: 2 }

/**
 * Whether merging `source` into `target` would let someone reach the source's people and
 * discussion who cannot today: the target's organisation level is above the source's, or the
 * source is restricted and the target is shared with a person (its creator included) or a role
 * the source is not.
 */
function widensAudience(
  source: Pick<Company, "orgAccess" | "createdBy" | "aclUserIds" | "aclRoleIds">,
  target: Pick<Company, "orgAccess" | "createdBy" | "aclUserIds" | "aclRoleIds">,
): boolean {
  if ((ORG_ACCESS_RANK[target.orgAccess] ?? 2) > (ORG_ACCESS_RANK[source.orgAccess] ?? 2))
    return true
  if (source.orgAccess !== "none") return false
  const users = new Set([
    ...(source.aclUserIds ?? []),
    ...(source.createdBy ? [source.createdBy] : []),
  ])
  const roles = new Set(source.aclRoleIds ?? [])
  const targetUsers = [
    ...(target.aclUserIds ?? []),
    ...(target.createdBy ? [target.createdBy] : []),
  ]
  return (
    targetUsers.some((u) => !users.has(u)) || (target.aclRoleIds ?? []).some((r) => !roles.has(r))
  )
}

/**
 * Fold `sourceId` into `targetId`, in one transaction, and delete the source.
 *
 * Under the caller's RLS: both must be visible, the target editable and the
 * source deletable, and a company the organisation sees is never folded into a
 * restricted one (its people and history would vanish for everyone else), nor
 * one into a target shared more widely than it (`widensAudience`). The
 * survivor keeps its own manager, or takes the source's when it has none; its
 * sharing does not change, so nobody, a portal account included, sees more
 * than before.
 *
 * Elevated, in the same transaction, every row naming the source names the
 * target, first the waiting items' company route (so the foreign key's
 * ON DELETE SET NULL never fires on one), then people with their company
 * text, portal accounts, other companies' not-the-same lists, deals and
 * pipelines (skipped where the projects app has no tables) and the
 * discussion. Only then is the source deleted.
 */
export async function mergeCompanies(
  db: RlsClient,
  params: { orgId: string; userId: string; sourceId: string; targetId: string },
): Promise<CompanyMergeResult> {
  const { orgId, userId, sourceId, targetId } = params
  if (sourceId === targetId) {
    throw new CompanyRequestError(422, "same_company", "A company cannot be merged into itself.")
  }
  return withElevatableRlsFrom(db, "company-merge", async (tx) => {
    const source = await loadVisible(tx, orgId, sourceId)
    const target = await loadVisible(tx, orgId, targetId)
    if (source.orgAccess !== "none" && target.orgAccess === "none") {
      throw new CompanyRequestError(
        422,
        "merge_narrows_access",
        `${target.name} is restricted and ${source.name} is seen by the organisation: merging would hide ${source.name}'s people and history from everyone else. Merge ${target.name} into ${source.name} instead.`,
      )
    }
    // The other direction is refused too: the survivor's sharing decides who reads the
    // source's people and discussion, so widening is an act of its own on the source.
    if (source.orgAccess === "none" && target.orgAccess !== "none") {
      throw new CompanyRequestError(
        422,
        "merge_widens_access",
        `Nothing was merged. ${source.name} is restricted and ${target.name} is seen by the organisation: merging would show ${source.name}'s people and discussion to everyone who sees ${target.name}. Next: widen ${source.name}'s sharing first, then merge.`,
      )
    }
    // Any other way the survivor reaches more people than the source: a wider organisation
    // level (view only into editable), or, for a restricted source, someone or a role the
    // target is shared with and the source is not.
    if (widensAudience(source, target)) {
      throw new CompanyRequestError(
        422,
        "merge_widens_access",
        `Nothing was merged. ${target.name} is shared more widely than ${source.name}: merging would show ${source.name}'s people and discussion to people who cannot see it today. Next: widen ${source.name}'s sharing first, then merge.`,
      )
    }
    // The survivor keeps its manager; with none it takes the source's, when that
    // person can still manage accounts (active, a member, not blind to companies).
    const inherited =
      !target.ownerUserId &&
      !!source.ownerUserId &&
      (await managerRefusal(orgId, source.ownerUserId)) === null
    const managerId = target.ownerUserId ?? (inherited ? source.ownerUserId : null)
    const managerFrom: CompanyMergeResult["managerFrom"] = target.ownerUserId
      ? "target"
      : inherited
        ? "source"
        : "none"
    const [kept] = await tx
      .update(companies)
      .set({
        ownerUserId: managerId,
        mainContactId: target.mainContactId ?? source.mainContactId ?? null,
        notSameAs: [...new Set([...target.notSameAs, ...source.notSameAs])].filter(
          (id) => id !== sourceId && id !== targetId,
        ),
        updatedAt: new Date(),
      })
      .where(and(eq(companies.id, targetId), eq(companies.orgId, orgId)))
      .returning()
    if (!kept) {
      throw new HTTPException(403, { message: `You can see ${target.name} but not change it.` })
    }

    const moved = await tx.transaction((sp) =>
      asAdmin(sp, async () => {
        const repoint = async (statement: ReturnType<typeof drizzleSql>) =>
          extractRows(await sp.execute(statement)).length
        // Waiting items first: they keep their company, now the survivor's manager's.
        const waitingApprovals = extractRows<{ status: string }>(
          await sp.execute(drizzleSql`
            UPDATE ${ks()}.approval_requests SET route_company_id = ${targetId}::uuid
             WHERE org_id = ${orgId}::uuid AND route_company_id = ${sourceId}::uuid
            RETURNING status`),
        ).filter((r) => r.status === "pending" || r.status === "approving").length
        await runCompanyMergeFailpoint("after-routes")
        const contactsMoved = await repoint(drizzleSql`
          UPDATE ${ks()}.contacts SET company_id = ${targetId}::uuid, company = ${kept.name}, updated_at = now()
           WHERE org_id = ${orgId}::uuid AND company_id = ${sourceId}::uuid
          RETURNING id`)
        const accounts = await repoint(drizzleSql`
          UPDATE ${ks()}.users SET company_id = ${targetId}::uuid
           WHERE org_id = ${orgId}::uuid AND company_id = ${sourceId}::uuid
          RETURNING id`)
        await sp.execute(drizzleSql`
          UPDATE ${ks()}.companies c
             SET not_same_as = ARRAY(
                   SELECT DISTINCT x FROM unnest(array_replace(c.not_same_as, ${sourceId}::uuid, ${targetId}::uuid)) AS x
                    WHERE x <> c.id)
           WHERE c.org_id = ${orgId}::uuid AND ${sourceId}::uuid = ANY(c.not_same_as)
             AND c.id NOT IN (${sourceId}::uuid, ${targetId}::uuid)`)
        let deals = 0
        let projects = 0
        if (await dealTablesExist(sp)) {
          deals = await repoint(drizzleSql`
            UPDATE ${ps()}.deals SET company_id = ${targetId}::uuid, updated_at = now()
             WHERE org_id = ${orgId}::uuid AND company_id = ${sourceId}::uuid
            RETURNING task_id`)
          projects = await repoint(drizzleSql`
            UPDATE ${ps()}.projects SET company_id = ${targetId}::uuid
             WHERE org_id = ${orgId}::uuid AND company_id = ${sourceId}::uuid
            RETURNING id`)
        }
        await repointAppCompanyLinks(sp, { orgId, sourceId, targetId })
        const discussionMoved = await mergeCompanyDiscussion(sp, {
          orgId,
          sourceId,
          targetId,
          keepUserId: actorUuid(userId),
        })
        await runCompanyMergeFailpoint("after-references")
        return {
          moved: { contacts: contactsMoved, accounts, waitingApprovals, deals, projects },
          discussionMoved,
        }
      }),
    )

    // The source goes under the caller's RLS: whoever may not delete it merges nothing.
    const [deleted] = await tx
      .delete(companies)
      .where(and(eq(companies.id, sourceId), eq(companies.orgId, orgId)))
      .returning({ id: companies.id })
    if (!deleted) {
      throw new HTTPException(403, { message: `You can see ${source.name} but not delete it.` })
    }

    const sourceRef = { id: source.id, name: source.name }
    const targetRef = { id: kept.id, name: kept.name }
    await tx.queueEvent({
      app: "kernel",
      entity: "company",
      action: "merge",
      orgId,
      actorId: userId,
      entityId: targetId,
      data: {
        sourceId,
        targetId,
        sourceName: source.name,
        moved: moved.moved,
        discussionMoved: moved.discussionMoved,
        audience: companyEventAudience(kept),
      },
    })
    await tx.queueEvent({
      app: "kernel",
      entity: "company",
      action: "update",
      orgId,
      actorId: userId,
      entityId: targetId,
      data: { ...kept, renamedPeople: 0, audience: companyEventAudience(kept) },
    })
    await tx.queueEvent({
      app: "kernel",
      entity: "company",
      action: "delete",
      orgId,
      actorId: userId,
      entityId: sourceId,
      // `mergedInto` lets a stale tab, and a late PATCH, name the survivor.
      data: { id: sourceId, mergedInto: targetId, audience: companyEventAudience(source) },
    })
    return {
      source: sourceRef,
      target: targetRef,
      managerId,
      managerFrom,
      moved: moved.moved,
      discussionMoved: moved.discussionMoved,
    }
  })
}

const COMPANY_DISCUSSION = { app: "kernel", entityType: "company" } as const

/**
 * The source's discussion joins the survivor's, in the merge transaction
 * (elevated), as a contact merge does (contacts/discussion.ts): references to
 * the source name the survivor; a lone source thread becomes the survivor's;
 * when both have one, the source's messages, reply followers, agent seats and
 * the approvals asked in it move, and the source thread goes. People seated in
 * it are not carried (the survivor's sharing decides who reads it). True when
 * messages changed thread.
 */
async function mergeCompanyDiscussion(
  h: RlsClient | RlsTx,
  params: { orgId: string; sourceId: string; targetId: string; keepUserId: string | null },
): Promise<boolean> {
  const { orgId, sourceId, targetId, keepUserId } = params
  const found = await entityDiscussionThreads(h, orgId, COMPANY_DISCUSSION, [sourceId, targetId])
  const source = found.get(sourceId)
  const target = found.get(targetId)

  await h.execute(drizzleSql`
    UPDATE ${ks()}.thread_references r SET entity_id = ${targetId}
     WHERE r.org_id = ${orgId}::uuid AND r.app = 'kernel' AND r.entity_type = 'company'
       AND r.entity_id = ${sourceId}
       AND NOT EXISTS (
         SELECT 1 FROM ${ks()}.thread_references t
          WHERE t.thread_id = r.thread_id AND t.app = 'kernel' AND t.entity_type = 'company'
            AND t.entity_id = ${targetId})`)
  await h.execute(drizzleSql`
    DELETE FROM ${ks()}.thread_references
     WHERE org_id = ${orgId}::uuid AND app = 'kernel' AND entity_type = 'company'
       AND entity_id = ${sourceId}`)
  if (!source) return false

  const dropPeople = (threadId: string) =>
    h.execute(drizzleSql`
      DELETE FROM ${ks()}.thread_participants
       WHERE org_id = ${orgId}::uuid AND thread_id = ${threadId}::uuid AND user_id IS NOT NULL
         AND (${keepUserId}::uuid IS NULL OR user_id <> ${keepUserId}::uuid)`)

  if (!target) {
    await h.execute(drizzleSql`
      UPDATE ${ks()}.threads
         SET handle = ${entityDiscussionHandle({ ...COMPANY_DISCUSSION, entityId: targetId })},
             created_from = jsonb_set(COALESCE(created_from, '{}'::jsonb), '{entityId}', to_jsonb(${targetId}::text))
       WHERE org_id = ${orgId}::uuid AND id = ${source}::uuid`)
    await dropPeople(source)
    return false
  }

  const followers = extractRows<{
    root_message_id: string
    user_id: string
    last_read_at: string | null
    created_at: string
  }>(
    await h.execute(drizzleSql`
      DELETE FROM ${ks()}.reply_thread_followers
       WHERE org_id = ${orgId}::uuid AND thread_id = ${source}::uuid
      RETURNING root_message_id::text AS root_message_id, user_id::text AS user_id,
                last_read_at::text AS last_read_at, created_at::text AS created_at`),
  )
  await h.execute(drizzleSql`
    INSERT INTO ${ks()}.thread_participants (thread_id, org_id, role, participant_type, agent_id, seat_origin)
    SELECT ${target}::uuid, org_id, role, participant_type, agent_id, seat_origin
      FROM ${ks()}.thread_participants
     WHERE org_id = ${orgId}::uuid AND thread_id = ${source}::uuid AND agent_id IS NOT NULL
    ON CONFLICT DO NOTHING`)
  await h.execute(drizzleSql`
    UPDATE ${ks()}.messages m
       SET thread_id = ${target}::uuid,
           external_ref = CASE WHEN m.external_ref IS NOT NULL AND EXISTS (
               SELECT 1 FROM ${ks()}.messages t
                WHERE t.org_id = m.org_id AND t.thread_id = ${target}::uuid
                  AND t.external_ref = m.external_ref)
             THEN NULL ELSE m.external_ref END
     WHERE m.org_id = ${orgId}::uuid AND m.thread_id = ${source}::uuid`)
  for (const f of followers) {
    await h.execute(drizzleSql`
      INSERT INTO ${ks()}.reply_thread_followers (root_message_id, thread_id, user_id, org_id, last_read_at, created_at)
      VALUES (${f.root_message_id}::uuid, ${target}::uuid, ${f.user_id}::uuid, ${orgId}::uuid,
              ${f.last_read_at}::timestamptz, ${f.created_at}::timestamptz)
      ON CONFLICT DO NOTHING`)
  }
  for (const column of ["thread_id", "originating_thread_id"]) {
    await h.execute(drizzleSql`
      UPDATE ${ks()}.approval_requests SET ${drizzleSql.raw(quoteIdent(column))} = ${target}::uuid
       WHERE org_id = ${orgId}::uuid AND ${drizzleSql.raw(quoteIdent(column))} = ${source}::uuid`)
  }
  await h.execute(drizzleSql`
    UPDATE ${ks()}.scope_requests SET originating_thread_id = ${target}::uuid
     WHERE org_id = ${orgId}::uuid AND originating_thread_id = ${source}::uuid`)
  await h.execute(drizzleSql`
    DELETE FROM ${ks()}.threads WHERE org_id = ${orgId}::uuid AND id = ${source}::uuid`)
  await unindexDiscussionThreads(orgId, [source])
  return true
}

let companyMergeFailpoint: ((stage: CompanyMergeStage) => Promise<void> | void) | null = null

/**
 * Arm a fault inside a company merge, at `stage` and after, to prove the merge
 * commits or rolls back whole. Refused in production; returns the disarm
 * function.
 */
export function armCompanyMergeFailpoint(
  fn: (stage: CompanyMergeStage) => Promise<void> | void,
): () => void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The company merge failpoint cannot be armed in production")
  }
  companyMergeFailpoint = fn
  return () => {
    companyMergeFailpoint = null
  }
}

async function runCompanyMergeFailpoint(stage: CompanyMergeStage): Promise<void> {
  if (companyMergeFailpoint) await companyMergeFailpoint(stage)
}

/* -------------------------------------------------------------------------- */
/* Proposals from contacts, and the batch link                                */
/* -------------------------------------------------------------------------- */

export const COMPANY_PROPOSAL_SCAN_CAP = 5000

export interface CompanyProposal {
  name: string
  domain: string | null
  contactIds: string[]
  count: number
  existingCompanyId: string | null
}

function emailDomain(email: string | null): string | null {
  const at = email?.lastIndexOf("@") ?? -1
  if (!email || at < 0) return null
  const host = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
  return host && !isConsumerMailDomain(host) ? host : null
}

/**
 * Groups of the caller's people who have no company yet, by their company
 * text (normalised) and, without one, by their business mail domain. Writes
 * nothing. Each group names an existing company it matches by name or domain.
 */
export async function proposeCompaniesFromContacts(
  tx: RlsClient,
  params: { orgId: string; limit?: number },
): Promise<{ groups: CompanyProposal[]; unmatched: number; coveragePartial: boolean }> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
  const people = await tx
    .select({ id: contacts.id, company: contacts.company, email: contacts.email })
    .from(contacts)
    .where(and(eq(contacts.orgId, params.orgId), drizzleSql`${contacts.companyId} IS NULL`))
    .orderBy(contacts.createdAt, contacts.id)
    .limit(COMPANY_PROPOSAL_SCAN_CAP + 1)
  const scanned = people.slice(0, COMPANY_PROPOSAL_SCAN_CAP)
  type Acc = { names: Map<string, number>; domains: Map<string, number>; ids: string[] }
  const groups = new Map<string, Acc>()
  const domainOnly = new Map<string, string>()
  let unmatched = 0
  const bump = (m: Map<string, number>, k: string | null) => {
    if (k) m.set(k, (m.get(k) ?? 0) + 1)
  }
  for (const p of scanned) {
    const key = companyNameKey(p.company)
    const domain = emailDomain(p.email)
    const groupKey = key ? `n:${key}` : domain ? `d:${domain}` : null
    if (!groupKey) {
      unmatched += 1
      continue
    }
    const acc: Acc = groups.get(groupKey) ?? { names: new Map(), domains: new Map(), ids: [] }
    bump(acc.names, p.company?.trim().replace(/\s+/g, " ") || null)
    bump(acc.domains, domain)
    acc.ids.push(p.id)
    groups.set(groupKey, acc)
    if (!key && domain) domainOnly.set(groupKey, domain)
  }
  const top = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  const existing = await tx
    .select({ id: companies.id, name: companies.name, domain: companies.domain })
    .from(companies)
    .where(eq(companies.orgId, params.orgId))
    .limit(COMPANY_DUPLICATE_SCAN_CAP)
  const byKey = new Map(existing.map((c) => [companyNameKey(c.name), c.id]))
  const byDomain = new Map(
    existing.filter((c) => c.domain).map((c) => [c.domain!.toLowerCase(), c.id]),
  )

  const out: CompanyProposal[] = [...groups.entries()].map(([groupKey, acc]) => {
    const domain = top(acc.domains)
    const name = top(acc.names) ?? domainOnly.get(groupKey) ?? groupKey.slice(2)
    return {
      name,
      domain,
      contactIds: acc.ids,
      count: acc.ids.length,
      existingCompanyId:
        byKey.get(companyNameKey(name)) ?? (domain ? byDomain.get(domain) : undefined) ?? null,
    }
  })
  out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return {
    groups: out.slice(0, limit),
    unmatched,
    coveragePartial: people.length > COMPANY_PROPOSAL_SCAN_CAP || out.length > limit,
  }
}

export interface CompanyBatchItem {
  name: string
  domain?: string | null
  contactIds: string[]
}

/**
 * Create each named company and link its people, in one transaction. People
 * the caller cannot change are skipped and named per company.
 */
export async function createAndLinkCompanies(
  db: RlsClient,
  params: { orgId: string; userId: string; items: CompanyBatchItem[] },
): Promise<{
  created: Array<CompanyRef & { linked: number; skipped: string[]; notice?: string }>
  linked: number
}> {
  const { orgId, userId, items } = params
  if (items.length > COMPANY_LINK_BATCH_MAX) {
    throw new CompanyRequestError(
      422,
      "too_many_companies",
      `A batch holds at most ${COMPANY_LINK_BATCH_MAX} companies.`,
    )
  }
  // The tool call or request runs in one transaction: every change below commits together.
  const tx = db
  const created: Array<CompanyRef & { linked: number; skipped: string[]; notice?: string }> = []
  let linked = 0
  for (const item of items) {
    const made = await createCompany(tx, {
      orgId,
      userId,
      input: { name: item.name, domain: item.domain ?? null },
    })
    const link = await linkContactsToCompany(tx, {
      orgId,
      userId,
      companyId: made.company.id,
      contactIds: item.contactIds,
    })
    linked += link.linked.length
    created.push({
      id: made.company.id,
      name: made.company.name,
      linked: link.linked.length,
      skipped: link.skipped,
      ...(made.notice ? { notice: made.notice } : {}),
    })
  }
  return { created, linked }
}

/* -------------------------------------------------------------------------- */
/* Sharing                                                                    */
/* -------------------------------------------------------------------------- */

export interface CompanySharing extends ResourceGrants {
  orgAccess: OrgAccess
  createdBy: string | null
  canManage: boolean
}

/** Who the company is shared with; whoever sees the company may read this. */
export async function getCompanySharing(
  tx: RlsClient,
  params: { orgId: string; companyId: string },
): Promise<CompanySharing> {
  const row = await loadVisible(tx, params.orgId, params.companyId)
  return {
    orgAccess: row.orgAccess,
    createdBy: row.createdBy,
    canManage: await canManageSharing(tx, COMPANY_RESOURCE, row.id),
    ...(await listGrants(tx, COMPANY_RESOURCE, row.id)),
  }
}

export interface CompanySharingInput extends Partial<ResourceGrants> {
  orgAccess: OrgAccess
}

/**
 * Change who sees the company: its general access and its grants (each kind
 * given replaces that kind, one left out is unchanged), through the generic
 * sharing model. Only whoever `kernel.can_manage_company_sharing` names may:
 * the creator, or for a company whose creator is gone, a contacts admin; the
 * database refuses everyone else too (the grants write policy and the
 * companies sharing guard). A company the caller cannot see answers 404.
 * Announced as `company:share` (audited, reindexed), its frame reaching
 * everyone who saw the company before or sees it now.
 */
export async function setCompanySharing(
  tx: RlsClient,
  params: { orgId: string; userId: string; companyId: string; sharing: CompanySharingInput },
): Promise<CompanySharing> {
  const row = await loadVisible(tx, params.orgId, params.companyId)
  if (!(await canManageSharing(tx, COMPANY_RESOURCE, row.id))) {
    throw new HTTPException(403, {
      message:
        "Only the company's creator (or, for a company whose creator is gone, a contacts admin) can change who it is shared with; nothing was changed",
    })
  }
  const { orgAccess, users, roles, dimensions } = params.sharing
  if (orgAccess === "none" && !row.createdBy) {
    throw new HTTPException(409, {
      message:
        "This company has no creator, so it stays visible to the organisation; share it with people instead. Nothing was changed",
    })
  }
  if (orgAccess !== row.orgAccess) {
    await tx
      .update(companies)
      .set({ orgAccess, updatedAt: new Date() })
      .where(and(eq(companies.id, row.id), eq(companies.orgId, params.orgId)))
  }
  await replaceGrants(
    tx,
    { orgId: params.orgId, userId: params.userId },
    COMPANY_RESOURCE,
    row.id,
    { users, roles, dimensions },
  )
  const [after] = await tx
    .select({
      orgAccess: companies.orgAccess,
      createdBy: companies.createdBy,
      aclUserIds: companies.aclUserIds,
    })
    .from(companies)
    .where(and(eq(companies.id, row.id), eq(companies.orgId, params.orgId)))
    .limit(1)
  const before = companyEventAudience(row)
  const now = after ? companyEventAudience(after) : before
  await tx.queueEvent({
    app: "kernel",
    entity: "company",
    action: "share",
    entityId: row.id,
    orgId: params.orgId,
    actorId: params.userId,
    actorType: "user",
    data: {
      id: row.id,
      orgAccess,
      previousOrgAccess: row.orgAccess,
      userCount: users?.length ?? null,
      roleCount: roles?.length ?? null,
      dimensionCount: dimensions?.length ?? null,
      // Whoever saw it before learns it changed (their tab then reads 404).
      audience: {
        orgWide: before.orgWide || now.orgWide,
        userIds: [...new Set([...before.userIds, ...now.userIds])],
      },
    },
  })
  if (!after) {
    // Restricted away from the caller (an admin managing a company whose
    // creator is gone, with no grant of their own): what was written.
    return {
      orgAccess,
      createdBy: row.createdBy,
      canManage: false,
      users: users ?? [],
      roles: roles ?? [],
      dimensions: dimensions ?? [],
    }
  }
  return getCompanySharing(tx, params)
}

/* -------------------------------------------------------------------------- */
/* Rename failpoint (tests only)                                              */
/* -------------------------------------------------------------------------- */

type Failpoint = () => Promise<void> | void
let afterCompanyRename: Failpoint | null = null

/**
 * Arm a fault after a rename has rewritten the people's company name, to prove
 * the rename and the rewrite commit or roll back together. Refused in
 * production; returns the disarm function.
 */
export function armAfterCompanyRenameFailpoint(fn: Failpoint): () => void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The company rename failpoint cannot be armed in production")
  }
  afterCompanyRename = fn
  return () => {
    afterCompanyRename = null
  }
}

async function runAfterCompanyRenameFailpoint(): Promise<void> {
  if (afterCompanyRename) await afterCompanyRename()
}

export function isCompanyRequestError(err: unknown): err is CompanyRequestError {
  return err instanceof CompanyRequestError
}
