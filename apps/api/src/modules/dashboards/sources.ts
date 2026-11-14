// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH TOOLS MAY FEED A DASHBOARD BLOCK, asked when a dashboard is saved and
// again on every run (a tool's manifest can change after the save, an app can
// be upgraded or turned off, the viewer's scopes can change).
//
// A source is a read the viewer may make: a known tool, enabled for the org,
// whose declaration says it reads (`readOnly`, no write target) and asks for
// nothing a view cannot give: not gated (statically or for some params), no
// outward effect, not a contract-only op, no human turn, no trust boundary, not a
// web read. A read hidden from the agent's catalog (a settings page's own read) is
// still a source: what the agent is offered and what a view may show are separate
// questions. Kernel tools are not judged by their marker alone: only the ones
// listed here qualify, and a read that hands out a secret never does.
//
// Every read is a source unless it is on the reviewed exclusion list of
// every-read-is-a-source.guard.test.ts, which fails CI for a read that is neither. An org's own custom app is
// a source under the same rules (its secrets are placed per request);
// another org's never is. A read that answers one document's text (DOCUMENT_TEXT_READS) or
// hands out a secret (SECRET_READS) is never one.
//
// The `readOnly` marker is still the app's own claim. What makes a view safe
// against a manifest that lies is the run itself, which is read-only
// (execute.ts): its bridge refuses every write, whatever the tool declared.

import { APP_DISABLED_CODE } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { type UserContext, withRlsContext } from "~/db/rls"
import { dashboardTables } from "~/db/schema/kernel"
import { checkToolScopes } from "~/modules/agent/scopes/required-scopes"
import { appVisibleToOrg } from "~/modules/apps/app-org-scope"
import { toolRegistry } from "~/modules/apps/app-registries"
import { dashboardSourceRefusal } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { isAppActiveForOrgAsync } from "~/modules/apps/org-apps"
import type { BlockSource } from "~/modules/dashboards/spec"
import { backingProvider, parseBacking } from "~/modules/dashboards/tables/backing"
import { type DeclaredCollection, getDeclaredCollection } from "~/modules/data-store/declared"
import { AGENT_STORE_APP } from "~/modules/data-store/service"
import { hasScope } from "~/modules/permissions/permissions"

/**
 * The kernel reads a dashboard may show: the org's own records and settings, read as the
 * viewer under the tool's scopes. The kernel reads left out are on the guard's exclusion
 * list with their reason (agent machinery, a person's own memory or computer, outside text).
 */
export const KERNEL_DASHBOARD_SOURCES: ReadonlySet<string> = new Set([
  "users_list",
  "users_search",
  "describe_user_access",
  "contacts_search",
  "contacts_read",
  "contacts_addresses_list",
  "contacts_find_duplicates",
  "contacts_groups_list",
  "contacts_group_members",
  "threads_list",
  "threads_search",
  "list_routines",
  "list_routine_events",
  "routine_tool_scopes",
  "approvals_list",
  "approval_policy_get",
  "policy_get",
  "audit_search",
  "companies_search",
  "companies_read",
  "company_timeline",
  "companies_find_duplicates",
  "companies_propose_from_contacts",
  "roles_list",
  "get_role",
  "list_scopes",
  "list_dimensions",
  "list_locked_capabilities",
  "list_skills",
  "skill_search",
  "skill_read",
  "subagent_list",
  "subagent_get",
  "ai_models_get",
  "files_list",
  "files_read",
  "document_templates_list",
  "document_template_get",
  "document_rules_list",
  "document_rules_match",
  "document_record_types_list",
  "product_attributes_list",
  "data_collections_list",
  "dashboards_list",
  "dashboards_get",
  "dashboards_history",
  "import_kinds",
  "import_reference",
  "import_sample",
  "import_status",
  "merge_imported_user_preview",
  "apps_build_list",
  "apps_build_get",
  "apps_build_versions",
  "apps_build_logs",
  "apps_build_preview",
  "config_export",
  "config_plan",
  "notifications_get",
  "sidebar_apps_get",
  "setup_state",
  // Dashboard tables (modules/dashboards/tables), under the viewer's RLS: the tables, one
  // table's columns and counts, its rows.
  "tables_list",
  "tables_get",
  "tables_query",
])

/**
 * App reads that hand out a secret (a webhook signing secret, for the operator setting up the
 * sender): never a source, whatever their declaration says, so the secret never reaches a
 * page or the dashboard cache.
 */
export const SECRET_READS: ReadonlySet<string> = new Set([
  "calls:webhook_info",
  "monitoring:webhook_info",
  "projects:webhook_info",
])

/**
 * App reads that answer one document's text, not records: never a source, whatever their
 * declaration says. A repository file or a Drive file is outside text, fenced for the agent
 * that asked for it, and the connector reference is the authoring guide an adapter's author
 * reads in their own turn. Neither has rows a block can chart.
 */
export const DOCUMENT_TEXT_READS: ReadonlyMap<string, string> = new Map([
  ["github:github_read_file", "it returns one repository file's text"],
  ["gitlab:gitlab_read_file", "it returns one repository file's text"],
  ["google-drive:read", "it returns one Drive file's text"],
  ["api-connector:connector_adapter_reference", "it returns the connector authoring guide"],
])

export type SourceRefusalCode = "unknown_tool" | "not_allowed" | "no_access"

export type SourceCheck =
  | { ok: true; tool: RegisteredTool }
  | { ok: false; code: SourceRefusalCode; message: string }

type RegisteredTool = NonNullable<ReturnType<typeof toolRegistry.get>>

/** Why the declaration of `tool` keeps it off dashboards, or null when it is a plain read. */
export const declarationRefusal = dashboardSourceRefusal

/** The tool registered for this org, filling the org's registries on a miss. */
async function lookupTool(
  orgId: string,
  app: string,
  name: string,
): Promise<RegisteredTool | null> {
  let tool = toolRegistry.get([orgId, app, name])
  if (!tool) {
    await ensureAppsForOrg(orgId)
    tool = toolRegistry.get([orgId, app, name])
  }
  return tool ?? null
}

/**
 * May `toolName` feed a block that `viewer` sees? `unknown_tool` and
 * `not_allowed` are the tool's own answer (the same for everyone); `no_access`
 * is this viewer's: they lack a scope the tool needs.
 */
export async function checkToolSource(
  orgId: string,
  toolName: string,
  viewer: { userId: string; scopes: string[] },
): Promise<SourceCheck> {
  const i = toolName.indexOf(":")
  const app = i === -1 ? "" : toolName.slice(0, i)
  const name = i === -1 ? "" : toolName.slice(i + 1)
  if (!app || !name) {
    return { ok: false, code: "unknown_tool", message: `'${toolName}' is not <app>:<tool>` }
  }
  if (app === "kernel" && !KERNEL_DASHBOARD_SOURCES.has(name)) {
    return {
      ok: false,
      code: "not_allowed",
      message: `${toolName} is not a dashboard source; kernel sources are ${[...KERNEL_DASHBOARD_SOURCES].map((n) => `kernel:${n}`).join(", ")}`,
    }
  }
  if (SECRET_READS.has(toolName)) {
    return {
      ok: false,
      code: "not_allowed",
      message: `${toolName} cannot feed a dashboard: it returns a secret`,
    }
  }
  const text = DOCUMENT_TEXT_READS.get(toolName)
  if (text) {
    return {
      ok: false,
      code: "not_allowed",
      message: `${toolName} cannot feed a dashboard: ${text}`,
    }
  }
  if (app !== "kernel" && !(await appVisibleToOrg(app, orgId))) {
    return {
      ok: false,
      code: "unknown_tool",
      message: `${toolName} is not a tool of this workspace`,
    }
  }
  const tool = await lookupTool(orgId, app, name)
  // Another person's own tool (a personal MCP server's) does not exist for this viewer.
  if (!tool || (tool.ownerUserId && tool.ownerUserId !== viewer.userId)) {
    return {
      ok: false,
      code: "unknown_tool",
      message: `${toolName} is not a tool of this workspace`,
    }
  }
  if (app !== "kernel" && !(await isAppActiveForOrgAsync(orgId, app))) {
    return {
      ok: false,
      code: "not_allowed",
      message: `${toolName}: ${APP_DISABLED_CODE}, the app is turned off`,
    }
  }
  const refusal = declarationRefusal(tool)
  if (refusal)
    return {
      ok: false,
      code: "not_allowed",
      message: `${toolName} cannot feed a dashboard: ${refusal}`,
    }
  const scopes = checkToolScopes(tool, viewer.scopes)
  if (!scopes.authorized) {
    return {
      ok: false,
      code: "no_access",
      message: `${toolName} needs ${scopes.missing.join(", ") || "a scope"}`,
    }
  }
  return { ok: true, tool }
}

export interface EligibleSource {
  tool: string
  description: string
  /** The tool's parameters, as JSON-schema property names, when it declares them. */
  params: string[]
  /** The fields of its result, when its manifest declares them (`returns.schema`). */
  outputFields: string[]
}

function paramNames(tool: RegisteredTool): string[] {
  const p = tool.params as
    | { shape?: Record<string, unknown>; properties?: Record<string, unknown> }
    | undefined
  if (!p) return []
  if (p.shape && typeof p.shape === "object") return Object.keys(p.shape)
  if (p.properties && typeof p.properties === "object") return Object.keys(p.properties)
  return []
}

/** Every tool this viewer could put on a dashboard, matching `query` (words of its name or description). */
export async function listEligibleSources(
  orgId: string,
  viewer: { userId: string; scopes: string[] },
  query?: string,
  limit = 30,
): Promise<EligibleSource[]> {
  await ensureAppsForOrg(orgId)
  const words = (query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 1)
  const out: EligibleSource[] = []
  const names: string[] = []
  for (const [[, app, name], tool] of toolRegistry.entriesOf(orgId)) {
    const full = `${app}:${name}`
    if (words.length) {
      const hay =
        `${full} ${tool.description} ${(tool.searchKeywords ?? []).join(" ")}`.toLowerCase()
      if (!words.some((w) => hay.includes(w))) continue
    }
    if (app === "kernel" ? !KERNEL_DASHBOARD_SOURCES.has(name) : declarationRefusal(tool) !== null)
      continue
    if (SECRET_READS.has(full) || DOCUMENT_TEXT_READS.has(full)) continue
    names.push(full)
  }
  for (const full of names.sort()) {
    if (out.length >= limit) break
    const check = await checkToolSource(orgId, full, viewer)
    if (!check.ok) continue
    out.push({
      tool: full,
      description: check.tool.description.slice(0, 300),
      params: paramNames(check.tool),
      outputFields: Object.keys(check.tool.returns?.schema ?? {}),
    })
  }
  return out
}

export type StoreSourceCheck =
  | { ok: true; declared: DeclaredCollection }
  | { ok: false; code: SourceRefusalCode; message: string }

/**
 * May `app`'s `collection` feed a block `viewer` sees? Only a collection its app
 * declares readable outside it (`agentReadable`), under the declared read scope
 * (the agent namespace: kernel:data:read). An undeclared one is its app's alone.
 */
export async function checkStoreSource(
  orgId: string,
  app: string,
  collection: string,
  viewer: { scopes: string[] },
): Promise<StoreSourceCheck> {
  if (app !== AGENT_STORE_APP) {
    await ensureAppsForOrg(orgId)
    if (!(await appVisibleToOrg(app, orgId))) {
      return { ok: false, code: "unknown_tool", message: `${app} is not an app of this workspace` }
    }
    if (!(await isAppActiveForOrgAsync(orgId, app))) {
      return {
        ok: false,
        code: "not_allowed",
        message: `${app}: ${APP_DISABLED_CODE}, the app is turned off`,
      }
    }
  }
  const declared = getDeclaredCollection(orgId, app, collection)
  if (!declared) {
    return {
      ok: false,
      code: "unknown_tool",
      message: `${app} declares no collection '${collection}'`,
    }
  }
  if (!declared.agentReadable) {
    return {
      ok: false,
      code: "not_allowed",
      message: `${app}'s collection '${collection}' is not readable outside the app`,
    }
  }
  if (!hasScope(declared.readScope, viewer.scopes)) {
    return {
      ok: false,
      code: "no_access",
      message: `${app}/${collection} needs ${declared.readScope}`,
    }
  }
  return { ok: true, declared }
}

export type TableSourceCheck =
  | { ok: true; tableId: string }
  | { ok: false; code: SourceRefusalCode; message: string }

/**
 * May `viewer` read this dashboard table on a block? Read scope plus viewer access to the table
 * (its sharing, under their RLS). A table they cannot read is refused exactly like a missing one.
 */
export async function checkTableSource(
  orgId: string,
  tableId: string,
  viewer: UserContext,
): Promise<TableSourceCheck> {
  if (!hasScope("kernel:dashboards:read", viewer.scopes)) {
    return { ok: false, code: "no_access", message: "a table needs kernel:dashboards:read" }
  }
  const stamp = await tableStamp(viewer, tableId)
  if (!stamp || viewer.orgId !== orgId) {
    return { ok: false, code: "no_access", message: `no table ${tableId} you can read` }
  }
  return { ok: true, tableId }
}

/**
 * What a table source's cached read is keyed on, read under the viewer's RLS: its rows
 * generation (moves with every row write, in its transaction) and version (columns, sharing).
 * Null when the viewer cannot read it. Read before the rows, so a read can never cache older
 * rows under a newer stamp.
 */
export async function tableStamp(
  viewer: UserContext,
  tableId: string,
): Promise<{ generation: number; version: number; tasks?: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(tableId)) return null
  return withRlsContext(viewer, async (tx) => {
    const [row] = await tx
      .select({
        generation: dashboardTables.rowsGeneration,
        version: dashboardTables.version,
        backing: dashboardTables.backing,
      })
      .from(dashboardTables)
      .where(and(eq(dashboardTables.id, tableId), eq(dashboardTables.orgId, viewer.orgId)))
      .limit(1)
    if (!row) return null
    const stamp = { generation: Number(row.generation), version: row.version }
    // A backed table's rows move with its parent's records too (tables/backing.ts).
    const backing = parseBacking(row.backing)
    const provider = backing ? await backingProvider(viewer.orgId, backing) : null
    return backing && provider
      ? { ...stamp, tasks: await provider.stamp(tx, viewer.orgId, backing.parentId) }
      : stamp
  })
}

/** Any source's eligibility for `viewer`: a tool, a store collection or a dashboard table. */
export async function checkSource(
  orgId: string,
  source: BlockSource,
  viewer: UserContext,
): Promise<{ ok: true } | { ok: false; code: SourceRefusalCode; message: string }> {
  if (source.kind === "tool") return checkToolSource(orgId, source.tool, viewer)
  if (source.kind === "store") return checkStoreSource(orgId, source.app, source.collection, viewer)
  return checkTableSource(orgId, source.table, viewer)
}
