// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import {
  agents,
  appDrafts,
  dashboards,
  dashboardTables,
  nodeSessions,
  routines,
  skills,
  threads,
} from "~/db/schema/kernel"
import { approvalRequests } from "~/db/schema/kernel/agent-memory"
import { companies } from "~/db/schema/kernel/companies"
import { contacts } from "~/db/schema/kernel/contacts"
import { schemaRef } from "~/db/schema-ref"
import { entityRegistry, type SearchIndexFields, viewRegistry } from "~/modules/apps/app-registries"
import { isMailEntitySuppressed } from "~/modules/mailbox-crypto/content-suppression"

export interface ReferenceDisplayResolved {
  tabType: string
  label: string
  icon: string
  snippet?: string
}

/** What the label readers need of a transaction: an RLS one or a privileged one. */
type LabelReader = Pick<PrivilegedDb, "select" | "execute">

interface ManifestMeta {
  tabType: string
  label: string
  icon: string
}

// Hardcoded fallback for kernel + apps not yet registered when reference resolution
// happens (e.g., before any org has been bootstrapped). Manifest registry wins when
// it has an entry.
const KERNEL_FALLBACK: Record<string, ManifestMeta> = {
  thread: { tabType: "kernel:thread", label: "Thread", icon: "MessageSquare" },
  contact: { tabType: "kernel:contact", label: "Contact", icon: "User" },
  company: { tabType: "kernel:company", label: "Company", icon: "Building2" },
  approval_request: {
    tabType: "kernel:approval_request",
    label: "Approval",
    icon: "ShieldCheck",
  },
}

function lookupFromRegistry(orgId: string, app: string, entityType: string): ManifestMeta | null {
  const candidates: string[] = orgId ? [orgId, "*"] : ["*"]
  for (const id of candidates) {
    const views = viewRegistry.get([id, app]) as
      | { tabTypes?: Record<string, { label?: string; icon?: string }> }
      | undefined
    const tab = views?.tabTypes?.[entityType]
    if (tab) {
      return {
        tabType: `${app}:${entityType}`,
        label: tab.label ?? entityType,
        icon: typeof tab.icon === "string" ? tab.icon : "Square",
      }
    }
  }
  return null
}

export function resolveReferenceMetadataFromManifests(
  app: string,
  entityType: string,
  orgId = "",
): ManifestMeta | null {
  const fromRegistry = lookupFromRegistry(orgId, app, entityType)
  if (fromRegistry) return fromRegistry
  if (app === "kernel") return KERNEL_FALLBACK[entityType] ?? null
  return null
}

function shortId(id: string): string {
  return id.length > 8 ? `#${id.slice(0, 8)}` : `#${id}`
}

// SQL-identifier guard. Registry values (tableName/labelField/indexFields) come
// from app manifests, but the manifest schema only types them as `string`. We
// interpolate them as raw identifiers, so reject anything that isn't a plain
// snake/camel identifier before it reaches the query builder.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

interface RegistryEntityShape {
  labelField: string
  handlePrefix: string
  tableName?: string
  external?: boolean
  readScope?: string
  indexFields?: SearchIndexFields
}

/**
 * Look up a non-kernel entity's registry declaration, preferring an org-scoped
 * registration and falling back to the wildcard one — same precedence as
 * `lookupFromRegistry` for view metadata.
 */
export function lookupEntityDecl(
  orgId: string,
  app: string,
  entityType: string,
): RegistryEntityShape | null {
  const candidates: string[] = orgId ? [orgId, "*"] : ["*"]
  for (const id of candidates) {
    const decl = entityRegistry.get([id, app, entityType])
    if (decl) return decl
  }
  return null
}

/**
 * THE ENTITY A TAB'S ID NAMES. A tab type is named for the page (`invoicing:detail`,
 * `contacts:contact-detail`), and its id is a record of an entity with another
 * name, so a lookup by the tab's name found nothing and the turn never said which
 * record was open. The tab type declares it (`views.tabTypes.<tab>.entity`): an
 * entity of the same app (`document`), or of another (`kernel:contact`).
 */
export function tabEntity(
  orgId: string,
  app: string,
  tabType: string,
): { app: string; entityType: string } | null {
  for (const id of orgId ? [orgId, "*"] : ["*"]) {
    const views = viewRegistry.get([id, app]) as
      | { tabTypes?: Record<string, { entity?: unknown }> }
      | undefined
    const entity = views?.tabTypes?.[tabType]?.entity
    if (typeof entity !== "string" || !entity) continue
    const sep = entity.indexOf(":")
    return sep === -1
      ? { app, entityType: entity }
      : { app: entity.slice(0, sep), entityType: entity.slice(sep + 1) }
  }
  return null
}

/** An id a page reported, fit to be named back to the model: nothing that could open a tag. */
const REPORTED_ID = /^[\w:/.@-]{1,200}$/

/**
 * A record of an entity that lives in another system (an ad, a Shopify order)
 * has no row to read its name from. What is known is the id the person's own
 * page reported, which tells them nothing they do not hold, so the turn names
 * it. An entity with a local table never comes here without being `external`:
 * no row there means the reader may not see it.
 */
export function externalEntitySnippet(params: {
  orgId: string
  app: string
  entityType: string
  entityId: string
}): string | null {
  const { orgId, app, entityType, entityId } = params
  const target = tabEntity(orgId, app, entityType) ?? { app, entityType }
  if (!lookupEntityDecl(orgId, target.app, target.entityType)?.external) return null
  if (!REPORTED_ID.test(entityId)) return null
  return `[Entity: ${app}:${entityType}, id: ${entityId}]`
}

/**
 * Resolve an app entity's label (and snippet) generically from its registry
 * declaration, with no per-app SQL. The label comes from the declared
 * `labelField`; an optional `indexFields.handle` column lets us render a
 * `#handle` fallback when the label is null. Tables live in the per-app schema
 * (`app_<appName>`) by convention.
 */
async function loadAppEntityLabelAndSnippet(
  tx: LabelReader,
  decl: RegistryEntityShape,
  params: {
    orgId: string
    app: string
    entityType: string
    entityId: string
    /** The name the snippet calls it by: the tab type a link opens, when one names it. */
    shownAs: string
  },
): Promise<{ label?: string; snippet?: string; handle?: string | null } | null> {
  const { orgId, app, entityType, entityId, shownAs } = params
  const tableName = decl.tableName
  const labelField = decl.labelField
  const handleField = decl.indexFields?.handle
  if (!tableName || !SAFE_IDENT.test(tableName) || !SAFE_IDENT.test(labelField)) return null
  if (handleField && !SAFE_IDENT.test(handleField)) return null
  if (!SAFE_IDENT.test(app)) return null

  // The app's schema as the database names it: a run namespace prefixes every schema.
  const schema = schemaRef(`app_${app}`)
  // An external entity may have no local table at all, and a failed read would
  // abort the caller's transaction.
  if (decl.external) {
    const found = await tx.execute(
      drizzleSql`SELECT to_regclass(${`"${schema}"."${tableName}"`}) IS NOT NULL AS present`,
    )
    if (!extractRows<{ present: boolean }>(found)[0]?.present) return null
  }
  const labelCol = drizzleSql.raw(`"${labelField}"`)
  const tableRef = drizzleSql.raw(`"${schema}"."${tableName}"`)
  const selectCols = handleField
    ? drizzleSql`${labelCol} AS label, ${drizzleSql.raw(`"${handleField}"`)} AS handle`
    : drizzleSql`${labelCol} AS label`

  const result = await tx.execute(drizzleSql`
    SELECT ${selectCols} FROM ${tableRef}
    WHERE id = ${entityId} AND org_id = ${orgId}
    LIMIT 1
  `)
  const row = extractRows<{ label?: string | null; handle?: string | null }>(result)[0]
  if (!row) return null

  // Invariant K, third of the three sites that read `labelField`. This snippet is
  // injected verbatim into the agent's referenced-entity context and from there
  // into the model's prompt and the persisted turn, so for an encrypted personal
  // mailbox the label is dropped and only the id survives. The agent still knows
  // WHICH conversation is referenced, and reads its content through the
  // client-fulfilled path.
  const mailSuppressed =
    app === "mail" &&
    (await withPrivilegedDb(orgId, "reference-display-mail-suppression", (ptx) =>
      isMailEntitySuppressed(ptx, orgId, entityType, entityId),
    ))
  if (mailSuppressed) {
    return {
      label: `${entityType} ${shortId(entityId)}`,
      handle: row.handle ?? null,
      snippet: `[Entity: ${shownAs}, id: ${entityId}] { content encrypted, readable only by the mailbox owner }`,
    }
  }

  const handle = row.handle ?? null
  const label = row.label ?? (handle ? `#${handle}` : shortId(entityId))
  const labelClause = row.label ? `${labelField}: "${row.label}"` : `${labelField}: "(unnamed)"`
  return {
    label,
    handle,
    snippet: `[Entity: ${shownAs}${handle ? ` #${handle}` : ""}, id: ${entityId}] { ${labelClause} }`,
  }
}

/** Longest value a view line quotes; the rest is cut. */
const LINE_VALUE_MAX = 120

/**
 * A value as it goes into a line the agent reads: cut to 120 characters, then
 * JSON-encoded, so a quote or a line break in a name cannot end the value and
 * start an instruction of its own.
 */
export function lineValue(value: string): string {
  return JSON.stringify(
    value.length > LINE_VALUE_MAX ? `${value.slice(0, LINE_VALUE_MAX)}…` : value,
  )
}

async function loadKnownEntityLabelAndSnippet(
  tx: LabelReader,
  params: { orgId: string; app: string; entityType: string; entityId: string },
): Promise<{ label?: string; snippet?: string; handle?: string | null } | null> {
  const { orgId, entityId } = params
  const shownAs = `${params.app}:${params.entityType}`
  const { app, entityType } = tabEntity(orgId, params.app, params.entityType) ?? params
  try {
    if (app === "kernel" && entityType === "thread") {
      const [row] = await tx
        .select({ handle: threads.handle, title: threads.title })
        .from(threads)
        .where(and(eq(threads.id, entityId), eq(threads.orgId, orgId)))
        .limit(1)
      if (!row) return null
      const label = row.title ?? `#${row.handle}`
      return {
        label,
        handle: row.handle,
        snippet: `[Entity: kernel:thread #${row.handle}, id: ${entityId}] { title: "${row.title ?? "(untitled)"}" }`,
      }
    }
    if (app === "kernel" && entityType === "contact") {
      const [row] = await tx
        .select({ name: contacts.name, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.id, entityId), eq(contacts.orgId, orgId)))
        .limit(1)
      if (!row) return null
      const label = row.name ?? row.email ?? "(unnamed)"
      return {
        label,
        snippet: `[Entity: kernel:contact, id: ${entityId}] { name: ${lineValue(row.name ?? "(unnamed)")}, email: ${lineValue(row.email ?? "")} }`,
      }
    }
    if (app === "kernel" && entityType === "company") {
      const [row] = await tx
        .select({ name: companies.name, domain: companies.domain, owner: companies.ownerUserId })
        .from(companies)
        .where(and(eq(companies.id, entityId), eq(companies.orgId, orgId)))
        .limit(1)
      if (!row) return null
      // The account manager and their away date, so "who looks after this" needs no tool step.
      const { companyAccountManager } = await import("~/modules/contacts/companies")
      const manager = await companyAccountManager(orgId, row.owner)
      const fields = [
        `name: ${lineValue(row.name)}`,
        ...(row.domain ? [`domain: ${lineValue(row.domain)}`] : []),
        `accountManager: ${manager ? lineValue(manager.name) : "none"}`,
        ...(manager?.away ? [`away: ${lineValue(`until ${manager.away.until}`)}`] : []),
      ]
      return {
        label: row.name,
        snippet: `[Entity: kernel:company, id: ${entityId}] { ${fields.join(", ")} }`,
      }
    }
    if (app === "kernel" && entityType === "approval_request") {
      // An approval is named by its own summary title ("Refund order 1042"),
      // read with `tx`'s visibility like every other kind.
      const [row] = await tx
        .select({ handle: approvalRequests.handle, summary: approvalRequests.summary })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.id, entityId), eq(approvalRequests.orgId, orgId)))
        .limit(1)
      if (!row) return null
      const title = (row.summary as { title?: unknown } | null)?.title
      const label = typeof title === "string" && title.trim().length > 0 ? title : row.handle
      return {
        label,
        snippet: `[Entity: kernel:approval_request ${row.handle}, id: ${entityId}] { title: "${label}" }`,
      }
    }
    if (app === "kernel" && entityType === "routine") {
      const [row] = await tx
        .select({ name: routines.name })
        .from(routines)
        .where(and(eq(routines.id, entityId), eq(routines.orgId, orgId)))
        .limit(1)
      if (!row) return null
      return {
        label: row.name,
        snippet: `[Entity: kernel:routine, id: ${entityId}] { name: "${row.name}" }`,
      }
    }
    if (app === "kernel" && entityType === "skill") {
      const [row] = await tx
        .select({ name: skills.name })
        .from(skills)
        .where(and(eq(skills.id, entityId), eq(skills.orgId, orgId)))
        .limit(1)
      if (!row) return null
      return {
        label: row.name,
        snippet: `[Entity: kernel:skill, id: ${entityId}] { name: "${row.name}" }`,
      }
    }
    if (app === "kernel" && entityType === "agent") {
      const [row] = await tx
        .select({ name: agents.displayName })
        .from(agents)
        .where(and(eq(agents.id, entityId), eq(agents.orgId, orgId)))
        .limit(1)
      if (!row) return null
      return {
        label: row.name,
        snippet: `[Entity: kernel:agent, id: ${entityId}] { name: "${row.name}" }`,
      }
    }
    if (app === "kernel" && entityType === "session") {
      const [row] = await tx
        .select({ title: nodeSessions.title })
        .from(nodeSessions)
        .where(and(eq(nodeSessions.id, entityId), eq(nodeSessions.orgId, orgId)))
        .limit(1)
      if (!row) return null
      return {
        label: row.title,
        snippet: `[Entity: kernel:session, id: ${entityId}] { title: "${row.title}" }`,
      }
    }
    if (app === "kernel" && entityType === "dashboard") {
      const [row] = await tx
        .select({ title: dashboards.title })
        .from(dashboards)
        .where(and(eq(dashboards.id, entityId), eq(dashboards.orgId, orgId)))
        .limit(1)
      if (!row) return null
      return {
        label: row.title,
        snippet: `[Entity: kernel:dashboard, id: ${entityId}] { title: "${row.title}" }`,
      }
    }
    if (app === "kernel" && entityType === "dashboard-table") {
      const [row] = await tx
        .select({ name: dashboardTables.name })
        .from(dashboardTables)
        .where(and(eq(dashboardTables.id, entityId), eq(dashboardTables.orgId, orgId)))
        .limit(1)
      if (!row) return null
      return {
        label: row.name,
        snippet: `[Entity: kernel:dashboard-table, id: ${entityId}] { name: "${row.name}" }`,
      }
    }
    if (app === "kernel" && entityType === "app-builder") {
      const [row] = await tx
        .select({ title: appDrafts.title })
        .from(appDrafts)
        .where(and(eq(appDrafts.id, entityId), eq(appDrafts.orgId, orgId)))
        .limit(1)
      if (!row) return null
      return {
        label: row.title,
        snippet: `[Entity: kernel:app-builder, id: ${entityId}] { title: "${row.title}" }`,
      }
    }
    // Non-kernel app entities resolve generically through the entity registry —
    // the declared `labelField`/`tableName`/`indexFields.handle` describe where
    // the label lives, so no per-app SQL or app-name branching is needed.
    const decl = lookupEntityDecl(orgId, app, entityType)
    if (decl) {
      return await loadAppEntityLabelAndSnippet(tx, decl, {
        orgId,
        app,
        entityType,
        entityId,
        shownAs,
      })
    }
  } catch {
    return null
  }
  return null
}

/**
 * An entity's own name (a task's title), read with `tx`'s visibility: null
 * when the entity is gone, its kind declares no label, or `tx` may not see it.
 */
export async function resolveEntityLabel(
  tx: LabelReader,
  params: { orgId: string; app: string; entityType: string; entityId: string },
): Promise<string | null> {
  const found = await loadKnownEntityLabelAndSnippet(tx, params)
  return found?.label ?? null
}

/**
 * The name and, when the kind has one, the generated handle of an entity, read with `tx`'s
 * visibility: null when `resolveEntityLabel` would be. The name can be anyone's words (a customer
 * writes a ticket's subject); the handle is the reference to give a model instead.
 */
export async function resolveEntityNaming(
  tx: LabelReader,
  params: { orgId: string; app: string; entityType: string; entityId: string },
): Promise<{ label: string; handle: string | null } | null> {
  const found = await loadKnownEntityLabelAndSnippet(tx, params)
  return found?.label ? { label: found.label, handle: found.handle ?? null } : null
}

export async function resolveReferenceDisplay(
  tx: RlsClient,
  params: { orgId: string; app: string; entityType: string; entityId: string },
): Promise<ReferenceDisplayResolved> {
  const meta = resolveReferenceMetadataFromManifests(params.app, params.entityType, params.orgId)
  const tabType = meta?.tabType ?? `${params.app}:${params.entityType}`
  const icon = meta?.icon ?? "Square"
  const enriched = await loadKnownEntityLabelAndSnippet(tx, params)
  const label = enriched?.label ?? `${meta?.label ?? params.entityType} ${shortId(params.entityId)}`
  return { tabType, icon, label, snippet: enriched?.snippet }
}
