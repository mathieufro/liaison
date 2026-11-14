// SPDX-License-Identifier: FSL-1.1-ALv2
import { rootLogger } from "~/lib/logger"
import { entityRegistry, type SearchIndexFields } from "~/modules/apps/app-registries"

const log = rootLogger.child({ module: "searchable-entities" })

/** An attribute name the search filter can carry verbatim: a plain identifier. */
export const SEARCH_ATTRIBUTE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/**
 * Kernel built-in searchable entity registrations. These cover threads,
 * users, contacts, and approval requests which are not declared via app
 * manifests but participate in unified search.
 */
const KERNEL_BUILTINS: Array<{
  app: string
  entityType: string
  schemaName: string
  tableName: string
  readScope: string
  labelField?: string
  handlePrefix?: string
  indexFields: SearchIndexFields
  permissionFields: {
    participantIdsField?: string
    dimensionFields?: string[]
    aclFields?: { orgWideField: string; userIdsField: string; roleIdsField: string }
  }
  mentionable: boolean
  indexFilter?: { field: string; includeValues: string[] }
}> = [
  {
    app: "kernel",
    entityType: "thread",
    schemaName: "kernel",
    tableName: "threads",
    readScope: "kernel:threads:read",
    labelField: "title",
    indexFields: { title: "title", handle: "handle" },
    permissionFields: { participantIdsField: "participant_ids" },
    mentionable: true,
  },
  {
    app: "kernel",
    entityType: "user",
    schemaName: "kernel",
    tableName: "users",
    readScope: "kernel:users:read",
    labelField: "name",
    handlePrefix: "@",
    indexFields: { title: "name", labelSecondary: "email" },
    permissionFields: {},
    mentionable: true,
    // Only active members are searchable/mentionable/assignable. Suspended and
    // deactivated accounts (incl. the Slack-import placeholder users) stay in
    // the DB for attribution but must never surface in pickers.
    indexFilter: { field: "status", includeValues: ["active"] },
  },
  {
    app: "kernel",
    entityType: "contact",
    schemaName: "kernel",
    tableName: "contacts",
    readScope: "kernel:contacts:read",
    labelField: "name",
    indexFields: { title: "name", handle: "handle", labelSecondary: "email" },
    // Contacts are shareable (modules/sharing): the same ACL projection as
    // Knowledge documents, so a restricted contact is found only by its owner
    // and those it is shared with (users, roles, or a mailbox's access set).
    permissionFields: {
      aclFields: {
        orgWideField: "org_wide",
        userIdsField: "acl_user_ids",
        roleIdsField: "acl_role_ids",
      },
    },
    mentionable: true,
  },
  {
    app: "kernel",
    entityType: "company",
    schemaName: "kernel",
    tableName: "companies",
    readScope: "kernel:companies:read",
    labelField: "name",
    indexFields: { title: "name", handle: "handle", labelSecondary: "domain" },
    // Shareable like contacts (migration 0293): a company shared with nobody is
    // found only by its creator and its grantees, never by its account manager.
    permissionFields: {
      aclFields: {
        orgWideField: "org_wide",
        userIdsField: "acl_user_ids",
        roleIdsField: "acl_role_ids",
      },
    },
    mentionable: false,
  },
  {
    app: "kernel",
    entityType: "approval_request",
    schemaName: "kernel",
    tableName: "approval_requests",
    readScope: "kernel:approvals:read",
    labelField: "handle",
    // The uuid is indexed too (as the secondary label): agents cite approvals
    // by `approvalRequestId`, and a reviewer pasting that uuid (or its first
    // 8 chars — Meili tokenizes on the hyphens, so the first segment matches
    // as a whole word) into global search must land on the approval. Without
    // it only the `request-N` handle was findable.
    indexFields: { title: "handle", labelSecondary: "id" },
    permissionFields: { participantIdsField: "participant_ids" },
    mentionable: true,
  },
]

export interface SearchableEntityRegistration {
  app: string
  entityType: string
  readScope: string
  tableName?: string
  schemaName?: string
  labelField?: string
  handlePrefix?: string
  indexFields?: SearchIndexFields
  permissionFields: {
    participantIdsField?: string
    dimensionFields?: string[]
    /** Generic ACL search primitive (mirrors participant_ids) — see permission-filter.ts. */
    aclFields?: { orgWideField: string; userIdsField: string; roleIdsField: string }
  }
  mentionable?: boolean
  /**
   * Document attributes this entity needs MeiliSearch to treat as filterable,
   * beyond the static set and the dimension/ACL fields. Declared on the
   * registration so the ONE settings definition (`expectedSettings` in
   * drift.ts) can union them in: an attribute applied to the index out of band
   * is stripped the next time drift detection reapplies settings, and every
   * query filtering on it starts erroring.
   */
  filterableAttributes?: string[]
  /**
   * Static row-eligibility filter: only rows whose `field` value is in
   * `includeValues` are indexed (and returned by the direct-DB mention
   * fallback). Rows failing the filter are treated as deleted by the
   * incremental indexer and skipped (then pruned) by the full reindex.
   */
  indexFilter?: { field: string; includeValues: string[] }
  /**
   * Soft-delete marker column (manifest `archivedField`, e.g. `archived_at`).
   * A row with a non-null value is not index-eligible, exactly like a row that
   * fails `indexFilter`: deleted by the incremental indexer, skipped (then
   * pruned) by the full reindex, excluded from the direct-DB mention fallback.
   */
  archivedField?: string
}

/**
 * True when the row is index-eligible: it passes the registration's
 * `indexFilter` (if any) and is not soft-deleted per `archivedField` (if any).
 */
export function rowPassesIndexFilter(
  reg: Pick<SearchableEntityRegistration, "indexFilter" | "archivedField">,
  row: Record<string, unknown>,
): boolean {
  if (reg.archivedField && row[reg.archivedField] != null) return false
  const filter = reg.indexFilter
  if (!filter) return true
  return filter.includeValues.includes(String(row[filter.field]))
}

export interface SearchableRegistrations {
  entities: SearchableEntityRegistration[]
  registeredReadScopes: string[]
  dimensionFields: string[]
  /**
   * Union of every distinct field name declared across all entities'
   * `aclFields` (orgWideField + userIdsField + roleIdsField), for the drift
   * detector to mark filterable — exactly like `dimensionFields`.
   */
  aclFieldNames: string[]
  /**
   * Distinct `aclFields` declarations across all entities (in practice one),
   * for {@link buildPermissionFilter} to build the ACL disjunct clause(s).
   */
  aclFieldDeclarations: Array<{ orgWideField: string; userIdsField: string; roleIdsField: string }>
  /** Maps `entity_type` to its `app` for routing/permission lookups. */
  entityTypeToApp: Record<string, string>
}

type AclFieldDecl = { orgWideField: string; userIdsField: string; roleIdsField: string }

/** One manifest entity declaration, as an org's registration stores it. */
export type SearchableEntityDecl = NonNullable<ReturnType<typeof entityRegistry.get>>

/** One app entity a searchable registration may come from. */
export interface SearchableEntitySource {
  app: string
  entityType: string
  decl: SearchableEntityDecl
}

/**
 * Collects every searchable entity registered for the given org, plus the
 * kernel built-ins. Returns the union of read scopes and dimension fields
 * needed by the permission filter builder.
 */
export function collectSearchableRegistrations(orgId: string): SearchableRegistrations {
  const sources: SearchableEntitySource[] = []
  for (const [[regOrgId, app, entityType], decl] of entityRegistry.entriesOf(orgId)) {
    if (regOrgId === orgId) sources.push({ app, entityType, decl })
  }
  return searchableRegistrationsFrom(sources, { orgId })
}

/**
 * The searchable registrations a set of app entities declares, plus the kernel
 * built-ins: the one mapping an org's registry (above) and the installed
 * catalog (`modules/apps/catalog-derivations.ts`) both go through.
 */
export function searchableRegistrationsFrom(
  sources: Iterable<SearchableEntitySource>,
  logContext: { orgId?: string } = {},
): SearchableRegistrations {
  const entities: SearchableEntityRegistration[] = KERNEL_BUILTINS.map((b) => ({ ...b }))
  const scopeSet = new Set<string>(KERNEL_BUILTINS.map((b) => b.readScope))
  const dimensionSet = new Set<string>()
  const aclFieldSet = new Set<string>()
  const aclDeclSeen = new Set<string>()
  const aclFieldDeclarations: Array<{
    orgWideField: string
    userIdsField: string
    roleIdsField: string
  }> = []
  const entityTypeToApp: Record<string, string> = {}
  for (const e of KERNEL_BUILTINS) entityTypeToApp[e.entityType] = e.app
  const addAclDecl = (aclFields: AclFieldDecl) => {
    aclFieldSet.add(aclFields.orgWideField)
    aclFieldSet.add(aclFields.userIdsField)
    aclFieldSet.add(aclFields.roleIdsField)
    const declKey = `${aclFields.orgWideField}|${aclFields.userIdsField}|${aclFields.roleIdsField}`
    if (!aclDeclSeen.has(declKey)) {
      aclDeclSeen.add(declKey)
      aclFieldDeclarations.push({ ...aclFields })
    }
  }
  for (const e of KERNEL_BUILTINS) {
    if (e.permissionFields?.aclFields) addAclDecl(e.permissionFields.aclFields)
  }

  for (const { app: appName, entityType: entityName, decl } of sources) {
    if (!decl.searchable) continue
    const readScope = decl.permissionFields?.readScope ?? decl.readScope
    if (!readScope) continue
    const dimensionFields = decl.permissionFields?.dimensionFields ?? []
    const aclFields = decl.permissionFields?.aclFields
    // These names are spliced into the search engine's filter expression as
    // attribute names (permission-filter.ts). A manifest-declared name that is
    // not a plain identifier could rewrite that filter, so an entity carrying
    // one is not searchable at all (dropping only the bad field would widen
    // what its documents show).
    const declaredNames = [
      ...dimensionFields,
      ...(aclFields
        ? [aclFields.orgWideField, aclFields.userIdsField, aclFields.roleIdsField]
        : []),
      ...(decl.permissionFields?.participantIdsField
        ? [decl.permissionFields.participantIdsField]
        : []),
    ]
    if (declaredNames.some((name) => !SEARCH_ATTRIBUTE_NAME.test(name))) {
      log.warn(
        { ...logContext, app: appName, entity: entityName },
        "searchable entity declares a permission field that is not a plain identifier; not indexed for search",
      )
      continue
    }
    for (const d of dimensionFields) dimensionSet.add(d)
    if (aclFields) addAclDecl(aclFields)
    scopeSet.add(readScope)
    entityTypeToApp[entityName] = appName
    entities.push({
      app: appName,
      entityType: entityName,
      readScope,
      tableName: decl.tableName,
      schemaName: `app_${appName}`,
      labelField: decl.labelField,
      handlePrefix: decl.handlePrefix,
      indexFields: decl.indexFields,
      archivedField: decl.archivedField,
      permissionFields: {
        participantIdsField: decl.permissionFields?.participantIdsField,
        dimensionFields,
        aclFields,
      },
      mentionable: true,
    })
  }

  return {
    entities,
    registeredReadScopes: Array.from(scopeSet),
    dimensionFields: Array.from(dimensionSet),
    aclFieldNames: Array.from(aclFieldSet),
    aclFieldDeclarations,
    entityTypeToApp,
  }
}
