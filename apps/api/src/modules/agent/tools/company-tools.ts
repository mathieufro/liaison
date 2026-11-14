// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The company tools: read and search companies, give them to an account
 * manager, link people to them, propose companies from people's company text
 * and mail domains, find or set aside duplicates, and merge them.
 *
 * Every call runs under the caller's RLS through `modules/contacts/companies.ts`.
 * The writes that change who handles an account or which people belong to a
 * company are gated and internal, like `contacts_write`: an agent's call waits
 * for a person, a person's own call runs at once. Results say what changed,
 * what was skipped and why, by name, and the next step.
 */
import type { ApprovalSummary } from "@liaison/shared"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { companies as companiesTable, contacts as contactsTable } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { UUID_RE } from "~/lib/uuid"
import { safeEnrichmentRows } from "~/modules/agent/tools/contact-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import { linkedAppLine, readActivity, readLinkedRecords } from "~/modules/contacts/activity"
import {
  COMPANY_LINK_BATCH_MAX,
  CompanyMergedError,
  type CompanyPatch,
  companyAccountManager,
  companyIdsUnknownTo,
  createAndLinkCompanies,
  createCompany,
  findCompanyDuplicates,
  getCompany,
  isCompanyRequestError,
  linkContactsToCompany,
  listCompanies,
  managerRefusal,
  markCompaniesNotSame,
  memberNames,
  mergeCompanies,
  proposeCompaniesFromContacts,
  type SetManagerResult,
  setCompanyManager,
  unlinkContactsFromCompany,
  updateCompany,
} from "~/modules/contacts/companies"

interface CompanyToolContext {
  userId: string
  orgId: string
  db: RlsClient
  scopes?: string[]
}

interface Requester {
  orgId: string
  userId?: string
  roles?: string[]
  dimensionGrants?: Record<string, string[]>
}

type ToolError = { error: { code: string; message: string; [k: string]: unknown } }

/** A person's role as their metadata records it, or null. */
function metadataRole(metadata: unknown): string | null {
  if (metadata && typeof metadata === "object" && "role" in metadata) {
    return typeof metadata.role === "string" ? metadata.role : null
  }
  return null
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolError {
  return { error: { code, message, ...extra } }
}

/** A refusal from the service as a tool error; anything else is rethrown. */
function asToolError(err: unknown): ToolError {
  if (isCompanyRequestError(err)) return fail(err.code, err.message)
  if (err instanceof CompanyMergedError) {
    return fail("NOT_FOUND", `${err.message} Use ${err.mergedInto.id} instead.`, {
      mergedInto: err.mergedInto,
    })
  }
  if (err instanceof HTTPException && err.status === 404) {
    return fail(
      "NOT_FOUND",
      "Company not found. Only pass an id you saw in a kernel__companies_search or kernel__companies_read result.",
    )
  }
  if (err instanceof HTTPException && err.status === 403) return fail("FORBIDDEN", err.message)
  throw err
}

const names = (list: { name: string }[]) => list.map((c) => c.name).join(", ")

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function handleCompaniesSearch(
  params: {
    query?: string
    limit?: number
    cursor?: string
    tag?: string
    hasOpenDeal?: boolean
    ownerUserId?: string
  },
  ctx: CompanyToolContext,
) {
  const limit = Math.min(params.limit ?? 20, 50)
  const page = params.cursor ? Math.max(1, Number(params.cursor) || 1) : 1
  const ownerUserId = params.ownerUserId === "me" ? ctx.userId : params.ownerUserId
  const { rows, total } = await listCompanies(ctx.db, {
    orgId: ctx.orgId,
    page,
    limit,
    query: params.query,
    tag: params.tag,
    ownerUserId,
    hasOpenDeal: params.hasOpenDeal,
  })
  const managers = await memberNames(
    ctx.orgId,
    rows.map((r) => r.ownerUserId ?? ""),
  )
  return {
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      domain: r.domain,
      description: r.description,
      peopleCount: r.peopleCount,
      accountManagerName: r.ownerUserId ? (managers.get(r.ownerUserId) ?? null) : null,
      updatedAt: r.updatedAt.toISOString(),
    })),
    totalCount: total,
    nextCursor: page * limit < total ? String(page + 1) : null,
  }
}

const PEOPLE_SHOWN = 50
const MAIL = drizzleSql.raw(quoteIdent(schemaRef("app_mail")))

const log = rootLogger.child({ module: "company-tools" })

/** Mail is already in the read as each person's last mail. */
const COMPANY_LINKED_SKIP = ["mail"]

/**
 * What the other apps hold for a company and its people, read as the caller:
 * one line per app for the agent, and per app the recent row titles the card
 * shows. A source the caller cannot read is absent; one that did not answer
 * says so.
 */
async function companyLinkedRecords(
  companyId: string,
  ctx: CompanyToolContext & {
    dimensionGrants?: UserContext["dimensionGrants"]
    roles?: UserContext["roles"]
  },
): Promise<{ lines: string[]; byApp: Record<string, string> }> {
  // Always the person: the call's provenance (agent, mcp) is not a row-security actor.
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
      companyId,
      skip: COMPANY_LINKED_SKIP,
    })
    if (!linked) return { lines: [], byApp: {} }
    const byApp: Record<string, string> = {}
    for (const app of linked.apps) {
      byApp[app.source] = app.kinds.flatMap((k) => k.recent).join("; ")
    }
    return {
      lines: [
        ...linked.apps.map(linkedAppLine),
        ...linked.unavailable.map(
          (u) =>
            `${u.label}: not read (${u.reason === "timeout" ? "no answer in time" : "error"}).`,
        ),
      ],
      byApp,
    }
  } catch (err) {
    log.warn({ err, companyId }, "company read: other apps' records not read")
    return { lines: ["Other apps' records for this company were not read (error)."], byApp: {} }
  }
}

export async function handleCompaniesRead(
  params: { companyId: string },
  ctx: CompanyToolContext & {
    dimensionGrants?: UserContext["dimensionGrants"]
    roles?: UserContext["roles"]
    callerApp?: string
  },
) {
  const row = await getCompany(ctx.db, { orgId: ctx.orgId, companyId: params.companyId })
  if (!row) {
    return fail(
      "NOT_FOUND",
      `Company not found: ${params.companyId}. Only pass an id you saw in a kernel__companies_search result.`,
    )
  }
  const people = await ctx.db
    .select({
      id: contactsTable.id,
      name: contactsTable.name,
      email: contactsTable.email,
      metadata: contactsTable.metadata,
    })
    .from(contactsTable)
    .where(and(eq(contactsTable.orgId, ctx.orgId), eq(contactsTable.companyId, row.id)))
    .orderBy(contactsTable.name, contactsTable.id)
    .limit(PEOPLE_SHOWN)
  // Last mail from each person, as far as the caller's mail access goes (none: no date).
  const ids = people.map((p) => p.id)
  const inbound =
    ids.length === 0
      ? []
      : await safeEnrichmentRows<{ contact_id: string; at: string }>(ctx.db, (tx) =>
          tx.execute(drizzleSql`
            SELECT c.contact_id::text AS contact_id, MAX(m.sent_at)::text AS at
              FROM ${MAIL}.conversations c
              JOIN ${MAIL}.messages m ON m.conversation_id = c.id
             WHERE c.org_id = ${ctx.orgId}::uuid AND m.direction = 'inbound'
               AND c.contact_id = ANY(${`{${ids.join(",")}}`}::uuid[])
             GROUP BY c.contact_id`),
        )
  const lastInbound = new Map(inbound.map((r) => [r.contact_id, r.at]))
  // An app reading a company app-to-app gets the company alone.
  const linked = ctx.callerApp ? { lines: [], byApp: {} } : await companyLinkedRecords(row.id, ctx)
  return {
    company: {
      id: row.id,
      name: row.name,
      handle: row.handle,
      domain: row.domain,
      description: row.description,
      tags: row.tags,
      closedAt: row.closedAt?.toISOString() ?? null,
      peopleCount: row.peopleCount,
      openDeal: row.openDeal,
    },
    accountManager: await companyAccountManager(ctx.orgId, row.ownerUserId),
    people: people.map((p) => ({
      id: p.id,
      name: p.name,
      role: metadataRole(p.metadata),
      email: p.email,
      isMain: p.id === row.mainContactId,
      lastInboundAt: lastInbound.get(p.id) ?? null,
    })),
    ...(row.peopleCount > PEOPLE_SHOWN
      ? { peopleNote: `Showing ${PEOPLE_SHOWN} of ${row.peopleCount} people.` }
      : {}),
    ...(linked.lines.length > 0 ? { linkedRecords: linked.lines, linked: linked.byApp } : {}),
  }
}

export async function handleCompaniesProposeFromContacts(
  params: { limit?: number },
  ctx: CompanyToolContext,
) {
  const result = await proposeCompaniesFromContacts(ctx.db, {
    orgId: ctx.orgId,
    limit: params.limit,
  })
  const fresh = result.groups.filter((g) => !g.existingCompanyId).length
  return {
    ...result,
    note:
      result.groups.length === 0
        ? "Nothing to propose: every person you can see either has a company or gives no company name and no business mail domain."
        : `Nothing was written. ${fresh} groups have no company yet: create and link them with kernel__companies_link_batch; link a group that matches an existing company with kernel__companies_link_contacts.`,
  }
}

export async function handleCompaniesFindDuplicates(_params: unknown, ctx: CompanyToolContext) {
  const result = await findCompanyDuplicates(ctx.db, { orgId: ctx.orgId })
  return {
    ...result,
    note:
      result.clusters.length === 0
        ? `No likely duplicates among the ${result.scannedCount} companies scanned.`
        : "A pair that is not the same can be set aside with kernel__companies_mark_not_same.",
  }
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export interface CompaniesWriteParams {
  companyId?: string
  companyIds?: string[]
  name?: string
  domain?: string | null
  description?: string | null
  ownerUserId?: string | null
  mainContactId?: string | null
  tags?: string[]
  metadata?: Record<string, unknown>
  closed?: boolean
}

const COMPANY_FIELDS = [
  "name",
  "domain",
  "description",
  "ownerUserId",
  "mainContactId",
  "tags",
  "metadata",
  "closed",
] as const

function fieldsSet(p: CompaniesWriteParams): string[] {
  return COMPANY_FIELDS.filter((f) => p[f] !== undefined)
}

/** Why the call's shape cannot run, before anything is read. */
function shapeRefusal(p: CompaniesWriteParams): ToolError | null {
  const fields = fieldsSet(p)
  if (p.companyIds !== undefined) {
    if (p.companyId !== undefined || fields.some((f) => f !== "ownerUserId")) {
      return fail(
        "INVALID_ARGUMENT",
        "companyIds changes the account manager only: pass companyIds with ownerUserId and nothing else.",
      )
    }
    if (p.ownerUserId === undefined) {
      return fail(
        "INVALID_ARGUMENT",
        "companyIds needs ownerUserId (a person id, or null to clear).",
      )
    }
    if (p.companyIds.length === 0) {
      return fail("INVALID_ARGUMENT", "companyIds is empty: name at least one company.")
    }
    return null
  }
  if (fields.length === 0) {
    return fail("INVALID_ARGUMENT", "Nothing to save: pass at least one field to set.")
  }
  if (!p.companyId && !p.name) {
    return fail("INVALID_ARGUMENT", "A new company needs a name; pass companyId to change one.")
  }
  if (!p.companyId && p.mainContactId) {
    return fail(
      "INVALID_ARGUMENT",
      "A new company has no people yet: create it, link its people, then set the main contact.",
    )
  }
  return null
}

function managerOutcome(result: SetManagerResult, target: string | null) {
  const who = result.manager?.name ?? "no account manager"
  const moved = result.moved
  const lines: string[] = []
  if (moved.length > 0) {
    lines.push(
      target === null
        ? `${names(moved)} now ${moved.length === 1 ? "has" : "have"} no account manager.`
        : `${names(moved)} ${moved.length === 1 ? "is" : "are"} now managed by ${who}.`,
    )
  }
  for (const s of result.skipped) lines.push(`${s.name} was not changed: ${s.reason}`)
  return {
    accountManager: result.manager,
    moved: moved.map((m) => ({ id: m.id, name: m.name })),
    skipped: result.skipped.map((s) => ({
      id: s.id,
      name: s.name,
      code: s.code,
      reason: s.reason,
    })),
    message: lines.join(" ") || "Nothing changed.",
  }
}

export async function handleCompaniesWrite(params: CompaniesWriteParams, ctx: CompanyToolContext) {
  const refusal = shapeRefusal(params)
  if (refusal) return refusal
  try {
    if (params.companyIds) {
      const result = await setCompanyManager(ctx.db, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        companyIds: params.companyIds,
        ownerUserId: params.ownerUserId ?? null,
      })
      return managerOutcome(result, params.ownerUserId ?? null)
    }
    // A named manager who cannot be one refuses the whole write: nothing is saved.
    if (params.ownerUserId) {
      const no = await managerRefusal(ctx.orgId, params.ownerUserId)
      if (no) return fail(no.code, no.reason)
    }
    let companyId = params.companyId
    let notice: string | undefined
    let created = false
    const patch: CompanyPatch = {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.domain !== undefined ? { domain: params.domain } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.tags !== undefined ? { tags: params.tags } : {}),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      ...(params.mainContactId !== undefined ? { mainContactId: params.mainContactId } : {}),
      ...(params.closed !== undefined ? { closed: params.closed } : {}),
    }
    if (!companyId) {
      const made = await createCompany(ctx.db, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        input: {
          name: params.name ?? "",
          domain: params.domain,
          description: params.description,
          tags: params.tags,
        },
      })
      companyId = made.company.id
      notice = made.notice
      created = true
      const rest: CompanyPatch = {
        ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
        ...(params.closed !== undefined ? { closed: params.closed } : {}),
      }
      if (Object.keys(rest).length > 0) {
        await updateCompany(ctx.db, {
          orgId: ctx.orgId,
          userId: ctx.userId,
          companyId,
          patch: rest,
        })
      }
    } else if (Object.keys(patch).length > 0) {
      notice = (
        await updateCompany(ctx.db, { orgId: ctx.orgId, userId: ctx.userId, companyId, patch })
      ).notice
    }
    let manager: ReturnType<typeof managerOutcome> | undefined
    if (params.ownerUserId !== undefined) {
      manager = managerOutcome(
        await setCompanyManager(ctx.db, {
          orgId: ctx.orgId,
          userId: ctx.userId,
          companyIds: [companyId],
          ownerUserId: params.ownerUserId,
        }),
        params.ownerUserId,
      )
    }
    const row = await getCompany(ctx.db, { orgId: ctx.orgId, companyId })
    const label = row?.name ?? params.name ?? companyId
    return {
      id: companyId,
      name: label,
      created,
      ...(notice ? { notice } : {}),
      ...(manager
        ? { accountManager: manager.accountManager, moved: manager.moved, skipped: manager.skipped }
        : {}),
      message: [
        created ? `Created ${label}.` : `Saved ${label}.`,
        ...(manager ? [manager.message] : []),
        ...(notice ? [notice] : []),
      ].join(" "),
    }
  } catch (err) {
    return asToolError(err)
  }
}

export async function handleCompaniesLinkContacts(
  params: { companyId: string; contactIds: string[]; unlink?: boolean },
  ctx: CompanyToolContext,
) {
  try {
    const base = { orgId: ctx.orgId, userId: ctx.userId, companyId: params.companyId }
    const company = await getCompany(ctx.db, { orgId: ctx.orgId, companyId: params.companyId })
    const name = company?.name ?? params.companyId
    if (params.unlink) {
      const r = await unlinkContactsFromCompany(ctx.db, { ...base, contactIds: params.contactIds })
      return {
        companyId: r.companyId,
        unlinked: r.unlinked.length,
        skipped: r.skipped,
        message: `${r.unlinked.length} people no longer belong to ${name}.${r.skipped.length ? ` ${r.skipped.length} were not linked to it or are not yours to change: ${r.skipped.join(", ")}.` : ""}`,
      }
    }
    const r = await linkContactsToCompany(ctx.db, { ...base, contactIds: params.contactIds })
    return {
      companyId: r.companyId,
      linked: r.linked.length,
      skipped: r.skipped,
      message: `${r.linked.length} people now belong to ${name}, with its name as their company.${r.skipped.length ? ` ${r.skipped.length} were not found or are not yours to change: ${r.skipped.join(", ")}.` : ""}`,
    }
  } catch (err) {
    return asToolError(err)
  }
}

export async function handleCompaniesLinkBatch(
  params: { items: Array<{ name: string; domain?: string; contactIds: string[] }> },
  ctx: CompanyToolContext,
) {
  try {
    const r = await createAndLinkCompanies(ctx.db, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      items: params.items,
    })
    const skipped = r.created.filter((c) => c.skipped.length > 0)
    return {
      created: r.created.length,
      linked: r.linked,
      companies: r.created,
      message: `Created ${r.created.length} companies and linked ${r.linked} people.${skipped.length ? ` Some people were not found or not yours to change, at ${names(skipped)}.` : ""}`,
    }
  } catch (err) {
    return asToolError(err)
  }
}

export async function handleCompaniesMarkNotSame(
  params: { aId: string; bId: string; undo?: boolean },
  ctx: CompanyToolContext,
) {
  try {
    const r = await markCompaniesNotSame(ctx.db, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      aId: params.aId,
      bId: params.bId,
      undo: params.undo,
    })
    return {
      ok: true,
      message: r.notSame
        ? `${r.a.name} and ${r.b.name} are marked as not the same, and will not be suggested as duplicates again. Undo with undo: true.`
        : `${r.a.name} and ${r.b.name} may be suggested as duplicates again.`,
    }
  } catch (err) {
    return asToolError(err)
  }
}

export async function handleCompaniesMerge(
  params: { sourceId: string; targetId: string },
  ctx: CompanyToolContext,
) {
  try {
    const r = await mergeCompanies(ctx.db, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      sourceId: params.sourceId,
      targetId: params.targetId,
    })
    const m = r.moved
    const parts = [
      `${m.contacts} people`,
      ...(m.accounts ? [`${m.accounts} portal accounts`] : []),
      `${m.deals} deals`,
      `${m.projects} pipelines`,
      `${m.waitingApprovals} waiting approvals`,
    ]
    const manager =
      r.managerId === null
        ? `${r.target.name} has no account manager.`
        : `${(await memberNames(ctx.orgId, [r.managerId])).get(r.managerId) ?? r.managerId} stays its account manager${r.managerFrom === "source" ? `, taken from ${r.source.name}` : ""}.`
    return {
      targetId: r.target.id,
      deletedId: r.source.id,
      moved: m,
      managerId: r.managerId,
      message: `${r.source.name} was merged into ${r.target.name} and deleted: ${parts.join(", ")} now name ${r.target.name}${r.discussionMoved ? ", and its discussion joined" : ""}. ${manager} Sharing of ${r.target.name} did not change.`,
    }
  } catch (err) {
    return asToolError(err)
  }
}

/* -------------------------------------------------------------------------- */
/* Stage-time checks and approval cards                                       */
/* -------------------------------------------------------------------------- */

const UNKNOWN_IDS =
  "Only pass ids you saw in a kernel__companies_search or kernel__companies_read result."

export async function companiesWritePreflight(params: CompaniesWriteParams, ctx: Requester) {
  const refusal = shapeRefusal(params)
  if (refusal) return refusal
  const ids = params.companyIds ?? (params.companyId ? [params.companyId] : [])
  const unknown = await companyIdsUnknownTo(ctx, ids)
  if (unknown.length > 0)
    return fail("NOT_FOUND", `Company not found: ${unknown.join(", ")}. ${UNKNOWN_IDS}`)
  if (params.ownerUserId) {
    const no = await managerRefusal(ctx.orgId, params.ownerUserId)
    if (no) return fail(no.code, no.reason)
  }
  return { ok: true }
}

export async function companiesLinkPreflight(params: { companyId: string }, ctx: Requester) {
  const unknown = await companyIdsUnknownTo(ctx, [params.companyId])
  if (unknown.length > 0)
    return fail("NOT_FOUND", `Company not found: ${params.companyId}. ${UNKNOWN_IDS}`)
  return { ok: true }
}

async function companyNamesFor(
  tx: RlsClient,
  orgId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const valid = ids.filter((i) => UUID_RE.test(i))
  if (valid.length === 0) return new Map()
  const rows = await tx
    .select({ id: companiesTable.id, name: companiesTable.name })
    .from(companiesTable)
    .where(
      and(
        eq(companiesTable.orgId, orgId),
        drizzleSql`${companiesTable.id} = ANY(${`{${valid.join(",")}}`}::uuid[])`,
      ),
    )
  return new Map(rows.map((r) => [r.id, r.name]))
}

const companyLink = (id: string, label: string) => ({
  label: label.slice(0, 100),
  app: "kernel",
  entityType: "company",
  entityId: id,
})

function capLines(lines: string[]): string[] {
  return lines.length > 8 ? [...lines.slice(0, 7), `and ${lines.length - 7} more`] : lines
}

export async function summarizeCompaniesWrite(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = (params ?? {}) as CompaniesWriteParams
  const ids = p.companyIds ?? (p.companyId ? [p.companyId] : [])
  const found = await companyNamesFor(ctx.tx, ctx.orgId, ids)
  const label = (id: string) => found.get(id) ?? id
  const person =
    p.ownerUserId === undefined
      ? undefined
      : p.ownerUserId === null
        ? null
        : ((await memberNames(ctx.orgId, [p.ownerUserId])).get(p.ownerUserId) ?? p.ownerUserId)
  const links = ids.slice(0, 10).map((id) => companyLink(id, label(id)))
  if (p.companyIds) {
    const what =
      p.companyIds.length === 1 ? label(p.companyIds[0]!) : `${p.companyIds.length} companies`
    return {
      kind: "companies_write",
      title: (person === null
        ? `Clear the account manager of ${what}`
        : `Give ${what} to ${person}`
      ).slice(0, 200),
      subtitle: "Account manager, in Liaison's companies",
      lines: capLines(p.companyIds.map(label)),
      links,
    }
  }
  const lines: string[] = []
  if (p.name !== undefined) lines.push(`Name → ${p.name}`)
  if (p.domain !== undefined) lines.push(`Domain → ${p.domain ?? "(none)"}`)
  if (p.description !== undefined) lines.push(`Description → ${p.description ?? "(none)"}`)
  if (person !== undefined) lines.push(`Account manager → ${person ?? "(none)"}`)
  if (p.mainContactId !== undefined) lines.push(`Main contact → ${p.mainContactId ?? "(none)"}`)
  if (p.tags !== undefined) lines.push(`Tags → ${p.tags.join(", ") || "(none)"}`)
  if (p.closed !== undefined) lines.push(p.closed ? "Relationship ended" : "Relationship reopened")
  for (const [k, v] of Object.entries(p.metadata ?? {})) {
    lines.push(`${k} → ${typeof v === "string" ? v : JSON.stringify(v)}`)
  }
  const target = p.companyId ? label(p.companyId) : (p.name ?? "(unnamed)")
  const title =
    p.companyId && person !== undefined && fieldsSet(p).length === 1
      ? person === null
        ? `Clear the account manager of ${target}`
        : `Give ${target} to ${person}`
      : p.companyId
        ? `Edit the company ${target}`
        : `Create the company ${target}`
  return {
    kind: "companies_write",
    title: title.slice(0, 200),
    subtitle: "In Liaison's companies",
    lines: capLines(lines.length > 0 ? lines : ["(no field to change)"]),
    ...(links.length > 0 ? { links } : {}),
  }
}

export async function summarizeCompaniesLinkContacts(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = (params ?? {}) as { companyId?: string; contactIds?: string[]; unlink?: boolean }
  const id = p.companyId ?? ""
  const name = (await companyNamesFor(ctx.tx, ctx.orgId, [id])).get(id) ?? id
  const people = await ctx.tx
    .select({ name: contactsTable.name, email: contactsTable.email })
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.orgId, ctx.orgId),
        drizzleSql`${contactsTable.id} = ANY(${`{${(p.contactIds ?? []).filter((i) => UUID_RE.test(i)).join(",")}}`}::uuid[])`,
      ),
    )
    .limit(8)
  const count = p.contactIds?.length ?? 0
  return {
    kind: "companies_link_contacts",
    title: (p.unlink
      ? `Remove ${count} people from ${name}`
      : `Link ${count} people to ${name}`
    ).slice(0, 200),
    subtitle: "Their company name follows the company",
    lines: capLines(people.map((c) => c.name ?? c.email ?? "(unnamed)")),
    links: [companyLink(id, name)],
  }
}

export async function summarizeCompaniesLinkBatch(params: unknown): Promise<ApprovalSummary> {
  const p = (params ?? {}) as { items?: Array<{ name: string; contactIds?: string[] }> }
  const items = p.items ?? []
  const people = items.reduce((n, i) => n + (i.contactIds?.length ?? 0), 0)
  return {
    kind: "companies_link_batch",
    title: `Create ${items.length} companies and link ${people} people`,
    subtitle: "In Liaison's companies",
    lines: capLines(items.map((i) => `${i.name}: ${i.contactIds?.length ?? 0} people`)),
  }
}

export async function companiesMergePreflight(
  params: { sourceId: string; targetId: string },
  ctx: Requester,
) {
  if (params.sourceId === params.targetId) {
    return fail("same_company", "sourceId and targetId are the same company: pass two companies.")
  }
  const unknown = await companyIdsUnknownTo(ctx, [params.sourceId, params.targetId])
  if (unknown.length > 0)
    return fail("NOT_FOUND", `Company not found: ${unknown.join(", ")}. ${UNKNOWN_IDS}`)
  return { ok: true }
}

/**
 * The merge card: which company goes and which stays, both managers and which
 * one stays, and that the survivor's sharing (portal accounts included) does
 * not widen.
 */
export async function summarizeCompaniesMerge(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = (params ?? {}) as { sourceId?: string; targetId?: string }
  const ids = [p.sourceId, p.targetId].filter((i): i is string => !!i && UUID_RE.test(i))
  const rows =
    ids.length === 0
      ? []
      : await ctx.tx
          .select({
            id: companiesTable.id,
            name: companiesTable.name,
            ownerUserId: companiesTable.ownerUserId,
          })
          .from(companiesTable)
          .where(
            and(
              eq(companiesTable.orgId, ctx.orgId),
              drizzleSql`${companiesTable.id} = ANY(${`{${ids.join(",")}}`}::uuid[])`,
            ),
          )
  const source = rows.find((r) => r.id === p.sourceId)
  const target = rows.find((r) => r.id === p.targetId)
  const sourceName = source?.name ?? p.sourceId ?? "(unknown)"
  const targetName = target?.name ?? p.targetId ?? "(unknown)"
  const managerIds = [source?.ownerUserId, target?.ownerUserId].filter((i): i is string => !!i)
  const who = await memberNames(ctx.orgId, managerIds)
  const nameOf = (id: string | null | undefined) => (id ? (who.get(id) ?? id) : "nobody")
  const lines = [
    `${sourceName} is deleted; its people, deals, pipelines and waiting approvals move to ${targetName}.`,
  ]
  const sm = source?.ownerUserId ?? null
  const tm = target?.ownerUserId ?? null
  if (sm && tm && sm !== tm) {
    lines.push(
      `Account managers: ${nameOf(tm)} (${targetName}) stays; ${nameOf(sm)} (${sourceName}) no longer manages it.`,
    )
  } else if (tm || sm) {
    lines.push(`Account manager: ${nameOf(tm ?? sm)} stays.`)
  }
  lines.push(
    `Sharing stays as ${targetName}'s: nobody, a portal account included, sees more than before.`,
  )
  lines.push("This cannot be undone.")
  return {
    kind: "companies_merge",
    title: `Merge ${sourceName} into ${targetName}`.slice(0, 200),
    subtitle: "In Liaison's companies",
    lines,
    links: [
      ...(target ? [companyLink(target.id, target.name)] : []),
      ...(source ? [companyLink(source.id, source.name)] : []),
    ],
  }
}

/**
 * A company's or a contact's timeline, as the page shows it, under the caller's
 * own scopes: each app answers only what the caller may read there.
 */
export async function handleCompanyTimeline(
  params: {
    companyId?: string
    contactId?: string
    before?: string
    limit?: number
    source?: string
  },
  ctx: CompanyToolContext & {
    actorType?: UserContext["actorType"]
    dimensionGrants?: UserContext["dimensionGrants"]
    roles?: UserContext["roles"]
    actingAgentId?: string
  },
) {
  const target = params.companyId
    ? { companyId: params.companyId }
    : params.contactId
      ? { contactId: params.contactId }
      : null
  if (!target) {
    return fail("invalid_params", "Nothing was read. Pass companyId or contactId.")
  }
  // Always the person: the call's provenance (agent, mcp) is not a row-security actor, and a
  // non-person actor would read with every dimension.
  const actor = {
    actorType: "user",
    userId: ctx.userId,
    orgId: ctx.orgId,
    scopes: ctx.scopes ?? [],
    dimensionGrants: ctx.dimensionGrants,
    roles: ctx.roles,
    ...(ctx.actingAgentId ? { actingAgentId: ctx.actingAgentId } : {}),
  } as UserContext
  const result = await readActivity({
    orgId: ctx.orgId,
    actor,
    target,
    before: params.before,
    limit: params.limit,
    source: params.source,
  })
  if (!result) {
    return fail(
      "NOT_FOUND",
      params.companyId
        ? `Nothing was read: company ${params.companyId} is not one you can see. Only pass an id you saw in a kernel__companies_search result.`
        : `Nothing was read: contact ${params.contactId} is not one you can see. Only pass an id you saw in a kernel__contacts_search result.`,
    )
  }
  return {
    ...result,
    ...(result.nextBefore ? { next: "Pass nextBefore as before for older rows." } : {}),
  }
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

const anyHandler = <P>(fn: (p: P, c: CompanyToolContext) => Promise<unknown>) =>
  fn as unknown as (params: unknown, ctx: any) => Promise<unknown>
const anyPreflight = <P>(fn: (p: P, c: Requester) => Promise<unknown>) =>
  fn as unknown as (params: unknown, ctx: any) => Promise<unknown>

const uuidOrNull = z.string().uuid().nullable()

/** The payments connector's app id: its linked records are keyed by it. */
const PAYMENTS_APP = "stripe"

/** Card of `companies_read`: the company, opening its page. */
const COMPANY_CARD = {
  kind: "entity",
  pill: { label: "Company" },
  title: "{{result.company.name}}",
  sub: "{{result.company.domain}}",
  open: { view: "company-detail", idPath: "result.company.id" },
  rows: [
    { label: { label: "Account manager" }, value: "{{result.accountManager.name}}" },
    { label: { label: "People" }, value: "{{result.company.peopleCount}}" },
    // What the other apps hold for them, each row only when that app answered with records.
    { label: { label: "Stripe" }, value: `{{result.linked.${PAYMENTS_APP}}}` },
    { label: { label: "Invoices" }, value: "{{result.linked.invoicing}}" },
    { label: { label: "Tickets" }, value: "{{result.linked.tickets}}" },
    { label: { label: "Deals and projects" }, value: "{{result.linked.projects}}" },
  ],
}

const COMPANY_LIST_CARD = {
  kind: "list",
  pill: { label: "Companies" },
  title: "Companies",
  items: {
    path: "result.items",
    label: "{{item.name}}",
    meta: "{{item.accountManagerName}}",
    limit: 10,
  },
}

const PROPOSAL_CARD = {
  kind: "list",
  pill: { label: "Companies" },
  title: "Proposed companies",
  items: { path: "result.groups", label: "{{item.name}}", meta: "{{item.domain}}", limit: 10 },
}

export function registerCompanyTools(orgId: string): void {
  toolRegistry.set([orgId, "kernel", "companies_search"], {
    appName: "kernel",
    name: "companies_search",
    readOnly: true,
    // Company names and domains, often created in bulk from the company text
    // people carry (senders, shop customers): the turn that read them is marked.
    taintSource: true,
    deferLoading: true,
    description:
      "Search companies by name or domain, with each one's account manager and people count. ownerUserId filters to one account manager's companies (a person id, or me).",
    searchKeywords: ["entreprise", "société", "client", "compte", "account", "company"],
    requiredScopes: ["kernel:companies:read"],
    params: z.object({
      query: z.string().optional(),
      limit: z.number().min(1).max(50).optional(),
      cursor: z.string().optional(),
      tag: z.string().optional(),
      hasOpenDeal: z.boolean().optional(),
      ownerUserId: z.union([z.literal("me"), z.string().uuid()]).optional(),
    }),
    handler: anyHandler(handleCompaniesSearch),
    returns: { schema: { items: "object" } },
    resultCard: COMPANY_LIST_CARD,
  })

  toolRegistry.set([orgId, "kernel", "companies_read"], {
    appName: "kernel",
    name: "companies_read",
    readOnly: true,
    // People's names and emails, often from outside the org.
    taintSource: true,
    deferLoading: true,
    description:
      "Read a company: its account manager (with away until and who is next in line), its people with the main contact and their last mail, and its newest open deal.",
    searchKeywords: ["entreprise", "société", "qui s'occupe", "responsable"],
    requiredScopes: ["kernel:companies:read"],
    params: z.object({ companyId: z.string().uuid() }),
    handler: anyHandler(handleCompaniesRead),
    readsFromTable: "kernel.companies",
    targetRowParam: "companyId",
    resultRowPath: "company.id",
    returns: { schema: { company: "object", accountManager: "object" } },
    resultCard: COMPANY_CARD,
  })

  toolRegistry.set([orgId, "kernel", "companies_write"], {
    appName: "kernel",
    name: "companies_write",
    deferLoading: true,
    description:
      "Create or change a company (omit companyId to create), or set its account manager with ownerUserId (null clears). To give accounts to someone, first list them with kernel__companies_search (ownerUserId), then call this once with companyIds and ownerUserId. Name the companies you are moving. GATED.",
    searchKeywords: ["entreprise", "responsable de compte", "account manager", "attribuer"],
    requiredScopes: ["kernel:companies:write"],
    trustBoundary: "user",
    gated: true,
    approvalImpact: "internal",
    params: z.object({
      companyId: z.string().uuid().optional(),
      companyIds: z.array(z.string().uuid()).max(COMPANY_LINK_BATCH_MAX).optional(),
      name: z.string().optional(),
      domain: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      ownerUserId: uuidOrNull.optional(),
      mainContactId: uuidOrNull.optional(),
      tags: z.array(z.string()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      closed: z.boolean().optional(),
    }),
    handler: anyHandler(handleCompaniesWrite),
    preflight: anyPreflight(companiesWritePreflight),
    writesToTable: "kernel.companies",
  })
  registerApprovalSummarizer(orgId, "kernel", "companies_write", summarizeCompaniesWrite)

  toolRegistry.set([orgId, "kernel", "companies_link_contacts"], {
    appName: "kernel",
    name: "companies_link_contacts",
    deferLoading: true,
    description:
      "Link people to a company (their company name becomes the company's), or unlink them with unlink: true. GATED.",
    searchKeywords: ["rattacher", "lier", "link"],
    requiredScopes: ["kernel:companies:write"],
    trustBoundary: "user",
    gated: true,
    approvalImpact: "internal",
    params: z.object({
      companyId: z.string().uuid(),
      contactIds: z.array(z.string().uuid()).min(1).max(COMPANY_LINK_BATCH_MAX),
      unlink: z.boolean().optional(),
    }),
    handler: anyHandler(handleCompaniesLinkContacts),
    preflight: anyPreflight(companiesLinkPreflight),
    writesToTable: "kernel.contacts",
  })
  registerApprovalSummarizer(
    orgId,
    "kernel",
    "companies_link_contacts",
    summarizeCompaniesLinkContacts,
  )

  toolRegistry.set([orgId, "kernel", "companies_link_batch"], {
    appName: "kernel",
    name: "companies_link_batch",
    deferLoading: true,
    description:
      "Create several companies and link their people in one approval, from kernel__companies_propose_from_contacts groups. GATED.",
    searchKeywords: ["créer des entreprises", "regrouper"],
    requiredScopes: ["kernel:companies:write"],
    trustBoundary: "user",
    gated: true,
    approvalImpact: "internal",
    params: z.object({
      items: z
        .array(
          z.object({
            name: z.string().min(1),
            domain: z.string().optional(),
            contactIds: z.array(z.string().uuid()).max(COMPANY_LINK_BATCH_MAX),
          }),
        )
        .min(1)
        .max(COMPANY_LINK_BATCH_MAX),
    }),
    handler: anyHandler(handleCompaniesLinkBatch),
    writesToTable: "kernel.companies",
  })
  registerApprovalSummarizer(orgId, "kernel", "companies_link_batch", summarizeCompaniesLinkBatch)

  toolRegistry.set([orgId, "kernel", "companies_propose_from_contacts"], {
    appName: "kernel",
    name: "companies_propose_from_contacts",
    readOnly: true,
    // Groups by the company text people carry, which senders and enrichment fill.
    taintSource: true,
    deferLoading: true,
    description:
      "Propose companies from people who have none, grouped by their company text and business mail domain. Writes nothing.",
    searchKeywords: ["proposer", "regrouper", "entreprises"],
    requiredScopes: ["kernel:companies:read"],
    params: z.object({ limit: z.number().min(1).max(200).optional() }),
    handler: anyHandler(handleCompaniesProposeFromContacts),
    returns: { schema: { groups: "object" } },
    resultCard: PROPOSAL_CARD,
  })

  toolRegistry.set([orgId, "kernel", "company_timeline"], {
    appName: "kernel",
    name: "company_timeline",
    readOnly: true,
    // Mail subjects and meeting titles are text people outside the org chose.
    taintSource: true,
    deferLoading: true,
    description:
      "A company's or a contact's timeline, newest first: mail, tickets, invoices, meetings and deals, from each app you can read. unavailable names an app that did not answer.",
    searchKeywords: ["historique", "activité", "chronologie", "timeline", "history"],
    requiredScopes: ["kernel:companies:read"],
    params: z.object({
      companyId: z.string().uuid().optional(),
      contactId: z.string().uuid().optional(),
      before: z.string().max(512).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      source: z.string().max(64).optional(),
    }),
    handler: anyHandler(handleCompanyTimeline),
    returns: { schema: { items: "object", unavailable: "object" } },
    resultCard: {
      kind: "list",
      pill: { label: "Timeline" },
      title: "Timeline",
      items: { path: "result.items", label: "{{item.title}}", meta: "{{item.at}}", limit: 10 },
    },
  })

  toolRegistry.set([orgId, "kernel", "companies_find_duplicates"], {
    appName: "kernel",
    name: "companies_find_duplicates",
    readOnly: true,
    // Returns company names and domains, as companies_search does.
    taintSource: true,
    deferLoading: true,
    description:
      "Find pairs of companies that look like one (same domain, same name, or both), skipping pairs marked not the same.",
    searchKeywords: ["doublon", "doublons", "duplicate"],
    requiredScopes: ["kernel:companies:read"],
    params: z.object({}),
    handler: anyHandler(handleCompaniesFindDuplicates),
    readsFromTable: "kernel.companies",
    resultRowPath: "clusters.ids",
  })

  toolRegistry.set([orgId, "kernel", "companies_mark_not_same"], {
    appName: "kernel",
    name: "companies_mark_not_same",
    deferLoading: true,
    description:
      "Mark two companies as not the same, so they are no longer suggested as duplicates; undo: true reverts it.",
    searchKeywords: ["pas un doublon", "not a duplicate"],
    requiredScopes: ["kernel:companies:write"],
    params: z.object({
      aId: z.string().uuid(),
      bId: z.string().uuid(),
      undo: z.boolean().optional(),
    }),
    handler: anyHandler(handleCompaniesMarkNotSame),
    writesToTable: "kernel.companies",
    targetRowParam: "aId",
  })

  toolRegistry.set([orgId, "kernel", "companies_merge"], {
    appName: "kernel",
    name: "companies_merge",
    deferLoading: true,
    description:
      "Merge a duplicate company into another: sourceId is deleted, targetId is kept and receives its people, deals and waiting items. GATED, cannot be undone.",
    searchKeywords: ["fusionner", "doublon", "merge"],
    requiredScopes: ["kernel:companies:write"],
    trustBoundary: "user",
    gated: true,
    approvalImpact: "internal",
    params: z.object({
      sourceId: z.string().uuid(),
      targetId: z.string().uuid(),
    }),
    handler: anyHandler(handleCompaniesMerge),
    preflight: anyPreflight(companiesMergePreflight),
    writesToTable: "kernel.companies",
    targetRowParam: "targetId",
  })
  registerApprovalSummarizer(orgId, "kernel", "companies_merge", summarizeCompaniesMerge)
}
