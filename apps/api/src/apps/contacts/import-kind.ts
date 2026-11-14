// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import kind `contacts.contact` (modules/imports): one contact per record,
 * inserted for the organisation (never through the resolve/merge path), its
 * source id kept in
 * `external_ids[<source>]` (`import` for a run with no source label).
 *
 * Imports only create (A14): a contact already known by the same source id or
 * the same email or phone (org-visible) is reported `skipped` and left untouched; no
 * second external id is merged into it. Concurrent runs of this kind are
 * serialized by the runner's per-kind lock, which with this precheck keeps
 * them from creating the same contact twice.
 *
 * A contact record may name its company (`companyName`, `companyDomain`): the
 * company is found by domain, else by name, else created, and the contact is
 * linked to it. Import kind `contacts.company` creates companies the same way
 * (a company the org already has, by source id, name or domain, is skipped).
 */
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { extractRows, type PrivilegedDb } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { nextHandle } from "~/lib/handle"
import { UUID_RE } from "~/lib/uuid"
import {
  CompanyRequestError,
  companyNameKey,
  createCompany,
  normaliseCompanyDomain,
} from "~/modules/contacts/companies"
import { importServiceClient } from "~/modules/imports/service-client"
import type {
  HostImportContext,
  HostImportHandler,
  HostRecordOutcome,
  ImportRowRef,
} from "~/modules/imports/types"
import { hasScope } from "~/modules/permissions/permissions"

export const contactImportRecordSchema = z.object({
  externalId: z.string().min(1),
  name: z.string().min(1),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  company: z.string().optional().nullable(),
  /** The company the person works for: found by domain, else name, else created. */
  companyName: z.string().optional().nullable(),
  companyDomain: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
})

export const companyImportRecordSchema = z.object({
  externalId: z.string().min(1),
  name: z.string().trim().min(1),
  domain: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  tags: z.array(z.string()).optional().nullable(),
})

/** The `external_ids` key a run's source ids live under. */
export function contactSourceKey(sourceLabel: string): string {
  return sourceLabel || "import"
}

export interface ImportedCompany {
  id: string
  name: string
  /** True when this call created it (its row goes on the run's ledger). */
  created: boolean
  /** Set when the typed domain was a personal mail domain and was not saved. */
  notice?: string
}

const COMPANY_WRITE_SCOPE = "kernel:companies:write"

/**
 * The companies among `found` the importer can see, as their own reads would: org-wide, made by
 * them (this run's own new ones included), or shared with them (their RLS). An unseen company
 * reads as no company, so an import never names, matches or links into one.
 */
async function seenByImporter<T extends { id: string }>(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  found: T[],
): Promise<T[]> {
  if (found.length === 0) return found
  const K = drizzleSql.raw(schemaRef("kernel"))
  const ids = drizzleSql.join(
    found.map((c) => drizzleSql`${c.id}::uuid`),
    drizzleSql`, `,
  )
  const actor = UUID_RE.test(ctx.actorUserId) ? ctx.actorUserId : null
  const seen = new Set(
    extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${K}.companies
        WHERE org_id = ${ctx.orgId}::uuid AND id IN (${ids})
          AND (org_access <> 'none' ${actor ? drizzleSql`OR created_by = ${actor}::uuid` : drizzleSql``})
      `),
    ).map((r) => r.id),
  )
  const rest = found.filter((c) => !seen.has(c.id))
  if (rest.length > 0) {
    const restIds = drizzleSql.join(
      rest.map((c) => drizzleSql`${c.id}::uuid`),
      drizzleSql`, `,
    )
    const shared = await ctx.withActorRls(async (rls) =>
      extractRows<{ id: string }>(
        await rls.execute(drizzleSql`
          SELECT id::text AS id FROM ${K}.companies WHERE id IN (${restIds})`),
      ),
    )
    for (const r of shared) seen.add(r.id)
  }
  return found.filter((c) => seen.has(c.id))
}

/**
 * The company a record names, as the import links it: by domain when one is
 * given (several sharing it: the one whose name matches, else the oldest),
 * else by name (ignoring legal-form words), else created, which needs a name
 * and the company write scope. Null when no company is named. A bad domain,
 * a domain alone that matches nothing, or a missing scope refuse the record in
 * plain words, before anything is written. `write: false` (a preview) never
 * creates: it answers what the run would do.
 */
export async function resolveImportCompany(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  named: { name?: string | null; domain?: string | null },
  opts: { write: boolean },
): Promise<ImportedCompany | null> {
  const name = named.name?.trim() || null
  const typedDomain = named.domain?.trim() || null
  if (!name && !typedDomain) return null
  let domain: string | null = null
  let notice: string | undefined
  if (typedDomain) {
    const d = normaliseCompanyDomain(typedDomain)
    domain = d.domain
    if ("refused" in d) {
      notice = `${d.typed} is a personal mail domain, so it was not used to find or save the company.`
    }
  }
  const K = drizzleSql.raw(schemaRef("kernel"))
  const key = companyNameKey(name)
  if (domain) {
    const byDomain = await seenByImporter(
      tx,
      ctx,
      extractRows<{ id: string; name: string }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id, name FROM ${K}.companies
          WHERE org_id = ${ctx.orgId}::uuid AND lower(domain) = ${domain}
          ORDER BY created_at, id
          LIMIT 20
        `),
      ),
    )
    const hit = byDomain.find((c) => key && companyNameKey(c.name) === key) ?? byDomain[0]
    if (hit) return { ...hit, created: false, ...(notice ? { notice } : {}) }
  }
  if (name && key) {
    const firstWord = key.split(" ")[0] ?? ""
    const like = `%${firstWord.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    const byName = extractRows<{ id: string; name: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id, name FROM ${K}.companies
        WHERE org_id = ${ctx.orgId}::uuid AND name ILIKE ${like}
        ORDER BY created_at, id
        LIMIT 200
      `),
    ).filter((c) => companyNameKey(c.name) === key)
    const hit = (await seenByImporter(tx, ctx, byName))[0]
    if (hit) return { ...hit, created: false, ...(notice ? { notice } : {}) }
  }
  // A preview writes nothing: companies its earlier records would create count as there.
  const pending = (ctx.runCache ?? ctx.cache).get("preview-companies") as Set<string> | undefined
  if (!opts.write && pending) {
    if (domain && pending.has(`d:${domain}`)) return { id: "", name: name ?? "", created: false }
    if (key && pending.has(`n:${key}`)) return { id: "", name: name ?? "", created: false }
  }
  if (!name) {
    throw new Error(
      `No company has the domain ${domain ?? typedDomain}. Give companyName as well to create it. Nothing was imported for this row.`,
    )
  }
  if (!hasScope(COMPANY_WRITE_SCOPE, ctx.actorScopes)) {
    throw new Error(
      `No company is called "${name}", and creating one needs company write access (${COMPANY_WRITE_SCOPE}). Import the companies first, or ask an admin. Nothing was imported for this row.`,
    )
  }
  if (!opts.write) {
    const set = pending ?? new Set<string>()
    if (domain) set.add(`d:${domain}`)
    if (key) set.add(`n:${key}`)
    ;(ctx.runCache ?? ctx.cache).set("preview-companies", set)
    return { id: "", name, created: true, ...(notice ? { notice } : {}) }
  }
  const { company } = await createCompany(importServiceClient(tx), {
    orgId: ctx.orgId,
    userId: ctx.actorUserId,
    input: { name, domain },
  })
  return { id: company.id, name: company.name, created: true, ...(notice ? { notice } : {}) }
}

/** The plain-words text of a refused company write. */
export function importErrorText(err: unknown): string {
  if (err instanceof CompanyRequestError) return `${err.code}: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

async function importContact(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
): Promise<HostRecordOutcome> {
  const record = contactImportRecordSchema.parse(raw)
  const { orgId } = ctx
  const K = drizzleSql.raw(schemaRef("kernel"))
  const sourceKey = contactSourceKey(ctx.sourceLabel)
  const email = record.email?.trim().toLowerCase() || null
  const phone = record.phone?.trim() || null
  const byId = JSON.stringify({ [sourceKey]: record.externalId })
  // Imports only create (A14): a contact the org already knows by this source
  // id, this email or this phone is skipped and never touched (the resolve
  // path would merge into it, and undo would then delete someone's contact).
  const existing = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${K}.contacts
      WHERE org_id = ${orgId}::uuid
        AND (external_ids @> ${byId}::jsonb
             ${email ? drizzleSql`OR (lower(email) = ${email} AND org_access <> 'none')` : drizzleSql``}
             ${phone ? drizzleSql`OR (phone = ${phone} AND org_access <> 'none')` : drizzleSql``})
      LIMIT 1
    `),
  )
  if (existing.length > 0) return { status: "skipped" as const, rows: [] }

  const rows: ImportRowRef[] = []
  const company = await resolveImportCompany(
    tx,
    ctx,
    { name: record.companyName, domain: record.companyDomain },
    { write: true },
  )
  if (company?.created) rows.push({ table: "kernel.companies", id: company.id })

  const handle = await nextHandle(tx, `${schemaRef("kernel")}.contact_handle_seq`, "@contact")
  const createdBy = UUID_RE.test(ctx.actorUserId) ? ctx.actorUserId : null
  const metadata = record.notes ? JSON.stringify({ notes: record.notes }) : null
  const inserted = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      INSERT INTO ${K}.contacts
        (org_id, handle, email, name, phone, company, company_id, external_ids, metadata, created_by, org_access)
      VALUES (${orgId}::uuid, ${handle}, ${email}, ${record.name}, ${phone},
              ${company ? company.name : (record.company ?? null)},
              ${company ? drizzleSql`${company.id}::uuid` : drizzleSql`NULL`}, ${byId}::jsonb,
              ${metadata}::jsonb, ${createdBy}::uuid, 'editor')
      RETURNING id
    `),
  )
  const id = inserted[0]?.id
  if (!id) throw new Error("contact insert returned no row")
  await tx.queueEvent({
    app: "kernel",
    entity: "contact",
    action: "create",
    orgId,
    actorId: createdBy ?? "00000000-0000-0000-0000-000000000000",
    entityId: id,
    data: { email, name: record.name, handle },
  })
  rows.push({ table: "kernel.contacts", id })
  return {
    status: "created" as const,
    rows,
    report: {
      ...(company
        ? { company: company.name, companyId: company.id, companyCreated: company.created }
        : {}),
      ...(company?.notice ? { companyNotice: company.notice } : {}),
    },
  }
}

/** A preview's check of one contact: skipped as the run skips it, refused as it refuses it. */
async function checkContact(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
): Promise<"created" | "skipped"> {
  const record = contactImportRecordSchema.parse(raw)
  const K = drizzleSql.raw(schemaRef("kernel"))
  const email = record.email?.trim().toLowerCase() || null
  const phone = record.phone?.trim() || null
  const byId = JSON.stringify({ [contactSourceKey(ctx.sourceLabel)]: record.externalId })
  const existing = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${K}.contacts
      WHERE org_id = ${ctx.orgId}::uuid
        AND (external_ids @> ${byId}::jsonb
             ${email ? drizzleSql`OR (lower(email) = ${email} AND org_access <> 'none')` : drizzleSql``}
             ${phone ? drizzleSql`OR (phone = ${phone} AND org_access <> 'none')` : drizzleSql``})
      LIMIT 1
    `),
  )
  if (existing.length > 0) return "skipped"
  await resolveImportCompany(
    tx,
    ctx,
    { name: record.companyName, domain: record.companyDomain },
    { write: false },
  )
  return "created"
}

export const contactImportHandler: HostImportHandler = {
  importRecord: importContact,
  checkRecord: checkContact,
  formatError: importErrorText,
}

/** A company the org already has that this record names: by source id, name or domain. */
async function existingCompany(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  record: z.infer<typeof companyImportRecordSchema>,
  domain: string | null,
): Promise<{ id: string; name: string; by: "source id" | "name" | "domain" } | null> {
  const K = drizzleSql.raw(schemaRef("kernel"))
  const byId = JSON.stringify({ [contactSourceKey(ctx.sourceLabel)]: record.externalId })
  const hit = (
    await seenByImporter(
      tx,
      ctx,
      extractRows<{ id: string; name: string }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id, name FROM ${K}.companies
          WHERE org_id = ${ctx.orgId}::uuid AND metadata->'externalIds' @> ${byId}::jsonb
          LIMIT 1
        `),
      ),
    )
  )[0]
  if (hit) return { ...hit, by: "source id" }
  const key = companyNameKey(record.name)
  const firstWord = key.split(" ")[0] ?? ""
  const like = `%${firstWord.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
  const candidates = await seenByImporter(
    tx,
    ctx,
    extractRows<{ id: string; name: string; domain: string | null }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id, name, domain FROM ${K}.companies
        WHERE org_id = ${ctx.orgId}::uuid
          AND (name ILIKE ${like} ${domain ? drizzleSql`OR lower(domain) = ${domain}` : drizzleSql``})
        ORDER BY created_at, id
        LIMIT 500
      `),
    ).filter(
      (c) =>
        (key && companyNameKey(c.name) === key) || (!!domain && c.domain?.toLowerCase() === domain),
    ),
  )
  const byName = candidates.find((c) => key && companyNameKey(c.name) === key)
  if (byName) return { id: byName.id, name: byName.name, by: "name" }
  const byDomain = domain ? candidates.find((c) => c.domain?.toLowerCase() === domain) : undefined
  return byDomain ? { id: byDomain.id, name: byDomain.name, by: "domain" } : null
}

/** What both the run and the preview refuse before reading anything else. */
function companyRecordRefusal(ctx: HostImportContext): string | null {
  return hasScope(COMPANY_WRITE_SCOPE, ctx.actorScopes)
    ? null
    : `Importing companies needs company write access (${COMPANY_WRITE_SCOPE}). Nothing was imported for this row.`
}

async function checkCompany(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
): Promise<"created" | "skipped"> {
  const record = companyImportRecordSchema.parse(raw)
  const refusal = companyRecordRefusal(ctx)
  if (refusal) throw new Error(refusal)
  const d = normaliseCompanyDomain(record.domain)
  return (await existingCompany(tx, ctx, record, d.domain)) ? "skipped" : "created"
}

async function importCompany(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
): Promise<HostRecordOutcome> {
  const record = companyImportRecordSchema.parse(raw)
  const refusal = companyRecordRefusal(ctx)
  if (refusal) throw new Error(refusal)
  const d = normaliseCompanyDomain(record.domain)
  // Imports only create: a company the org already has is reported, never changed.
  const existing = await existingCompany(tx, ctx, record, d.domain)
  if (existing) {
    return {
      status: "skipped" as const,
      rows: [],
      report: {
        matchedCompany: existing.name,
        matchedCompanyId: existing.id,
        matchedBy: existing.by,
      },
    }
  }
  const { company, notice } = await createCompany(importServiceClient(tx), {
    orgId: ctx.orgId,
    userId: ctx.actorUserId,
    input: {
      name: record.name,
      domain: record.domain ?? null,
      description: record.description ?? null,
      ...(record.tags ? { tags: record.tags } : {}),
    },
  })
  // The source id the dedup reads next time, kept like a contact's external_ids.
  const K = drizzleSql.raw(schemaRef("kernel"))
  const externalIds = JSON.stringify({ [contactSourceKey(ctx.sourceLabel)]: record.externalId })
  await tx.execute(drizzleSql`
    UPDATE ${K}.companies
    SET metadata = jsonb_build_object('externalIds', ${externalIds}::jsonb)
    WHERE id = ${company.id}::uuid AND org_id = ${ctx.orgId}::uuid
  `)
  return {
    status: "created" as const,
    rows: [{ table: "kernel.companies", id: company.id }],
    report: { ...(notice ? { companyNotice: notice } : {}) },
  }
}

export const companyImportHandler: HostImportHandler = {
  importRecord: importCompany,
  checkRecord: checkCompany,
  formatError: importErrorText,
}
