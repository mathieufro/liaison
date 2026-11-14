// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The org's current configuration in the shape of `liaison config apply`, so
 * an agent reads what is there before proposing a change, and a section it
 * exports plans back as "unchanged". Secrets are never returned: a separate
 * `secrets` list says which connections have theirs set.
 *
 * Exported: roles, email, users, apps (the api-connector entry with its connections:
 * identifiers and
 * adapter documents), knowledge collections, invoicing issuer profiles and the
 * Liaison team opt-ins (operator only).
 * mail and tickets have no reader yet and say so.
 */

import { commercialIdentitySchema, orgKernelSettingsSchema } from "@liaison/shared"
import { and, sql as drizzleSql, eq, isNull } from "drizzle-orm"
import { listKnowledgeCollections } from "~/apps/knowledge/collections"
import { knowledgeActorFromContext } from "~/apps/knowledge/service"
import { knowledgeDimensionGrants } from "~/cli/provisioners/knowledge"
import { storedRoleScopes } from "~/cli/provisioners/roles"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { agents, roles, userRoles, users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { getOrgKernelSettings } from "~/lib/settings"
import { COMMON_AGENT_BASE_SCOPES } from "~/modules/agent/directory/common-base-scopes"
import { type ApiConnDecl, apiConnFor } from "~/modules/apps/connections/api/declarations"
import { getEnabledApps } from "~/modules/apps/enabled-apps"
import { canManageInstanceApps } from "~/modules/apps/operator-org"
import { loadSharing } from "~/modules/liaison-team/settings"
import { hasScope } from "~/modules/permissions/permissions"
import type { ProvisionActor } from "~/modules/provisioning/config-sections"

const log = rootLogger.child({ module: "config-export" })

export const NOT_EXPORTABLE = "not exportable yet"

export interface ConfigExport {
  config: Record<string, unknown>
  /** Which secrets are set, never their values. */
  secrets: Array<{ section: string; identifier: string; state: "set" | "missing" }>
}

export type Priv = <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>

export async function exportOrgConfig(orgId: string, actor: ProvisionActor): Promise<ConfigExport> {
  const priv: Priv = (reason, fn) => withPrivilegedDb(orgId, reason, fn)
  const secrets: ConfigExport["secrets"] = []
  // Each section is read only by a person holding that section's own read
  // scope (the scope its REST reader requires); without it the section is left
  // out and says which scope it needs. config_export itself needs
  // kernel:org:admin, which covers roles, email and enabled apps.
  const gated = async (scope: string, read: () => Promise<unknown>): Promise<unknown> =>
    hasScope(scope, actor.scopes) ? read() : `left out: needs ${scope}`
  const config: Record<string, unknown> = {
    setup: await exportSetup(priv, orgId),
    roles: await exportRoles(priv, orgId),
    email: await exportEmail(priv, orgId),
    users: await gated("kernel:users:read", () => exportUsers(priv, orgId)),
    mail: NOT_EXPORTABLE,
    tickets: NOT_EXPORTABLE,
    apps: await Promise.all(
      (await getEnabledApps(orgId)).map(async (name) => {
        // An app's API connection (declarations.ts): its adapters, in the
        // provisioning field it declares, and the accounts whose credentials
        // the file names (values never exported).
        const api = apiConnFor(orgId, name)
        if (!api) return { name, enable: true }
        const connectors = await gated(api.decl.adminScope, () =>
          exportApiConnectors(priv, api, secrets),
        )
        return { name, enable: true, ...(connectors as Record<string, unknown>) }
      }),
    ),
    knowledge: { collections: await exportCollections(orgId, actor) },
    agents: await gated("kernel:agents:read", () => exportAgents(priv, orgId)),
    invoicing: await gated("invoicing:settings:read", async () => ({
      issuerProfiles: await exportIssuerProfiles(priv, orgId),
    })),
    liaisonTeam: await exportLiaisonTeam(orgId),
  }
  return { config, secrets }
}

/** The two Liaison team opt-ins; only the instance operator's org decides them. */
export async function exportLiaisonTeam(orgId: string) {
  if (!(await canManageInstanceApps(orgId))) {
    return "left out: only the instance operator's organization decides this"
  }
  const sharing = await loadSharing()
  return { register: sharing.register, forwardBugReports: sharing.forwardBugReports }
}

export async function exportRoles(priv: Priv, orgId: string) {
  const stored = await storedRoleScopes(priv, orgId)
  return [...stored.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, r]) => ({
      name,
      ...(r.description ? { description: r.description } : {}),
      scopes: [...r.scopes].sort(),
    }))
}

/** The chosen setup features; absent until the person answered. */
export async function exportSetup(priv: Priv, orgId: string) {
  const settings = await priv("config-export-setup", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  return settings.chosenFeatures ? { features: settings.chosenFeatures } : {}
}

export async function exportEmail(priv: Priv, orgId: string) {
  const settings = await priv("config-export-email", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  const identity = commercialIdentitySchema.safeParse(settings.commercialIdentity)
  return {
    ...(settings.email?.from !== undefined ? { from: settings.email.from } : {}),
    ...(settings.email?.replyTo !== undefined ? { replyTo: settings.email.replyTo } : {}),
    ...(identity.success ? { commercialIdentity: identity.data } : {}),
  }
}

async function exportUsers(priv: Priv, orgId: string) {
  const rows = await priv("config-export-users", (tx) =>
    tx
      .select({ email: users.email, name: users.name, role: roles.name })
      .from(users)
      .innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.orgId, orgId)))
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(and(eq(users.orgId, orgId), eq(users.status, "active"))),
  )
  const byEmail = new Map<string, { email: string; name: string; role: string }>()
  for (const r of rows) if (!byEmail.has(r.email)) byEmail.set(r.email, r)
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email))
}

async function exportApiConnectors(
  priv: Priv,
  api: ApiConnDecl,
  secrets: ConfigExport["secrets"],
): Promise<Record<string, unknown>> {
  const { listAdapterRows } = await import("~/modules/apps/connections/api/store")
  const orgId = api.orgId
  let rows: Awaited<ReturnType<typeof listAdapterRows>>
  try {
    rows = await listAdapterRows(api)
  } catch (err) {
    log.debug({ err, orgId, app: api.app }, "config export: no API connection adapters")
    return {}
  }
  const connected = new Set(
    extractRows<{ identifier: string }>(
      await priv("config-export-api-connections", (tx) =>
        tx.execute(drizzleSql`
          SELECT identifier FROM ${drizzleSql.raw(schemaRef("kernel"))}.connected_accounts
          WHERE org_id = ${orgId}::uuid AND app_name = ${api.app}
            AND connection_name = ${api.connection} AND status = 'active'`),
      ),
    ).map((r) => r.identifier),
  )
  for (const r of rows) {
    secrets.push({
      section: `apps.${api.app}.connections`,
      identifier: r.identifier,
      state: connected.has(r.identifier) ? "set" : "missing",
    })
  }
  if (rows.length === 0) return {}
  const key = api.decl.provisionKey
  return {
    ...(key
      ? {
          provision: { [key]: rows.map((r) => ({ identifier: r.identifier, adapter: r.adapter })) },
        }
      : {}),
    connections: rows.map((r) => ({ name: api.connection, identifier: r.identifier })),
  }
}

async function exportCollections(orgId: string, actor: ProvisionActor) {
  const list = await withRlsContext(
    {
      actorType: "user",
      userId: actor.userId,
      orgId,
      scopes: actor.scopes,
      dimensionGrants: actor.dimensionGrants,
    },
    (rls) =>
      listKnowledgeCollections(
        rls,
        knowledgeActorFromContext({
          orgId,
          userId: actor.userId,
          scopes: actor.scopes,
          dimensionGrants: knowledgeDimensionGrants(actor.dimensionGrants),
        }),
      ),
  )
  return [...new Set(list.map((c) => c.name))].sort().map((name) => ({ name }))
}

export async function exportAgents(priv: Priv, orgId: string) {
  const base = new Set<string>(COMMON_AGENT_BASE_SCOPES)
  const rows = await priv("config-export-agents", (tx) =>
    tx
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.kind, "role"), isNull(agents.archivedAt))),
  )
  return rows
    .sort((a, b) => a.handle.localeCompare(b.handle))
    .map((a) => {
      const scopes = (a.scopeCeiling ?? []).filter((s) => !base.has(s))
      return {
        handle: a.handle,
        displayName: a.displayName,
        ...(a.purpose ? { purpose: a.purpose } : {}),
        ...(a.systemPrompt ? { systemPrompt: a.systemPrompt } : {}),
        ...(scopes.length > 0 ? { scopes } : {}),
        ...(a.modelPreference ? { model: a.modelPreference } : {}),
      }
    })
}

/** Stored column → config key for an issuer profile (logo excluded). */
const ISSUER_COLUMNS: Array<[string, string]> = [
  ["legal_name", "legalName"],
  ["country", "country"],
  ["vat_id", "vatId"],
  ["tax_registration_id", "taxRegistrationId"],
  ["address", "address"],
  ["iban", "iban"],
  ["swift_bic", "swiftBic"],
  ["bank_name", "bankName"],
  ["default_currency", "defaultCurrency"],
  ["default_language", "defaultLanguage"],
  ["default_payment_terms_days", "paymentTermsDays"],
  ["auto_email_enabled", "autoEmail"],
  ["invoice_approval_threshold_minor", "invoiceApprovalThresholdMinor"],
  ["shopify_shop_id", "shopifyShop"],
  ["siren", "siren"],
  ["siret", "siret"],
  ["legal_form", "legalForm"],
  ["share_capital", "shareCapital"],
  ["rcs_city", "rcsCity"],
  ["vat_on_debits_default", "vatOnDebits"],
  ["routing_address", "routingAddress"],
  ["address_line1", "addressLine1"],
  ["address_line2", "addressLine2"],
  ["postcode", "postcode"],
  ["city", "city"],
  ["country_code", "countryCode"],
]

export async function exportIssuerProfiles(priv: Priv, orgId: string) {
  const invSchema = schemaRef("app_invoicing")
  const present = extractRows(
    await priv("config-export-invoicing-preflight", (tx) =>
      tx.execute(drizzleSql`
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${invSchema} AND table_name = 'issuer_profiles'`),
    ),
  )
  if (present.length === 0) return []
  const cols = drizzleSql.raw(ISSUER_COLUMNS.map(([c]) => c).join(", "))
  const rows = extractRows<Record<string, unknown>>(
    await priv("config-export-invoicing", (tx) =>
      tx.execute(drizzleSql`
        SELECT ${cols} FROM ${drizzleSql.raw(`${invSchema}.issuer_profiles`)}
        WHERE org_id = ${orgId}::uuid ORDER BY legal_name`),
    ),
  )
  return rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const [column, key] of ISSUER_COLUMNS) {
      const value = row[column]
      if (value === null || value === undefined) continue
      out[key] =
        key === "invoiceApprovalThresholdMinor" || key === "paymentTermsDays"
          ? Number(value)
          : value
    }
    return out
  })
}
