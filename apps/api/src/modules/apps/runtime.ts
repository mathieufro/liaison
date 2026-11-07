// SPDX-License-Identifier: FSL-1.1-ALv2

import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { appSettingsSchema } from "@liaison/app-sdk"
import { sql as drizzleSql, inArray, type SQL } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withPrivilegedDb, withSchemaAdmin } from "~/db/privileged"
import { apps } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import {
  currentHandlerSignal,
  HANDLER_TIMEOUT_MS,
  subscribeToEvent,
} from "~/infra/events/event-bus"
import { registerJobWorker, unregisterAppJobHandlers } from "~/infra/jobs/jobs"
import { withPinnedJobSlot } from "~/infra/jobs/pinned-jobs-gate"
import { isManagedEdition } from "~/lib/edition"
import { appsLogger as log } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { describeDbError } from "~/lib/transient-db-error"
import { derivedSinkReadScope } from "~/modules/agent/scopes/taint-read-scopes"
import {
  appVisibleToOrg,
  filterAppsVisibleToOrg,
  firstAppStatus,
  isOrgPrivateApp,
} from "~/modules/apps/app-org-scope"
// --- In-process registries ---
import {
  type ApprovalSummarizer,
  agentInstructionsRegistry,
  appBridgeManifestRegistry,
  appCapabilitiesRegistry,
  appContractCallsRegistry,
  appContractImplementationsRegistry,
  appCrossAppCallsRegistry,
  appDependenciesRegistry,
  appPromptRegistry,
  approvalDedupeKeyRegistry,
  approvalDedupeSameRequesterRegistry,
  approvalEditableFieldsRegistry,
  approvalExpiryRegistry,
  approvalResourceOwnerRegistry,
  approvalSummarizerRegistry,
  appSettingsRegistry,
  assertReferenceableOutputs,
  attentionItemsRegistry,
  connectionBeforeDisconnectRegistry,
  connectionConfigRegistry,
  contributionRegistry,
  declaredEmits,
  deleteDeclaredEmits,
  dimensionDefRegistry,
  entityRegistry,
  eventSubscriptionDisposers,
  exportRegistry,
  getDeclaredEmits,
  importRegistry,
  manifestAttentionAxesRegistry,
  manifestAttentionRegistry,
  manifestFileParentRegistry,
  manifestRegistry,
  oauthClientResolverRegistry,
  orgsRegistering,
  registeredApps,
  registeredAppVersions,
  routineTemplateRegistry,
  setDeclaredEmits,
  skillRegistry,
  slotRegistry,
  timelineDeclarations,
  toolRegistry,
  viewRegistry,
  webhookHandlers,
} from "~/modules/apps/app-registries"
import {
  registerApprovalSummarizer,
  templateApprovalSummarizer,
} from "~/modules/apps/approval-summarizers"
import { projectBulkToolSchemas } from "~/modules/apps/bulk-field-schemas"
import { manifestFileParentOf } from "~/modules/apps/catalog-derivations"
import {
  firstPartyOnlyToolKeyErrors,
  validateAppDescriptor,
  validateAppManifest,
} from "~/modules/apps/contract"
// --- DDL helpers ---
import {
  computeSchemaHash,
  declaredPartialUniqueIndexNames,
  declaredTableUniqueColumns,
  enumCheckMatches,
  generateAlterTableDdl,
  generateDropImmutableTriggerDdl,
  generateDropIndexDdl,
  generateEnumCheckReconcileDdl,
  generateImmutableTriggerDdl,
  generateNotNullTightenDdl,
  generateSequenceDdl,
  generateTableDdl,
  generateTableUniqueAddDdl,
  generateTriggerDdl,
  isFieldNullable,
  mapFieldTypeToPgDataType,
  validateIdentifier,
} from "~/modules/apps/ddl"
import { hostApiIncompatibility } from "~/modules/apps/host-api"
import { resolveOperatorOrgId } from "~/modules/apps/operator-org"
import { isAppActiveForOrgAsync, noteAppRegistered } from "~/modules/apps/org-apps"
import {
  pauseAppRoutinesForOrg,
  reconcileAgents,
  reconcileDefaultDisabledSkills,
  resumeAppRoutinesForOrg,
} from "~/modules/apps/reconcile-assets"
import { APP_REGISTRATION_CODE_FILES } from "~/modules/apps/registration-code-files"
import {
  buildManifestSettingsEntry,
  materialiseSections,
  namespaceDefaultsFor,
  namespaceSchemaFor,
} from "~/modules/apps/settings-schema-from-manifest"
import { reviewTriggerBody } from "~/modules/apps/trigger-review"
import { orgSuspendedOrClosed } from "~/modules/cloud/billing-status"
import { BUILTIN_EXPORT_HANDLERS } from "~/modules/export/builtin-handlers"
import { BUILTIN_IMPORT_KINDS } from "~/modules/imports/builtin-kinds"
import { type ImportKindDecl, importKindRestrictionErrors } from "~/modules/imports/kind-schema"

export class AppRegistrationFatalError extends Error {
  constructor(
    public readonly code:
      | "missing_tool_dependency"
      | "manifest_invalid"
      | "role_cycle"
      | "entity_schema_mismatch",
    public readonly details: Record<string, unknown>,
    message: string,
  ) {
    super(message)
    this.name = "AppRegistrationFatalError"
  }
}

import { TAINT_ENFORCING_SINKS } from "~/modules/agent/scopes/scope-taint"
import {
  closeRegistryJournal,
  openRegistryJournal,
  type RegistryJournal,
} from "~/modules/apps/registries"
import { resolveAppOrder } from "~/modules/apps/resolver"
import { grantableScopesWithAppAliases } from "~/modules/apps/runtime-helpers"
import {
  appBridgeExtensionRegistry,
  type BridgeExtensionFactory,
} from "~/modules/apps/sandbox/bridge-extensions"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { createSandboxRpcBridge, createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { orgSetupLockSql } from "~/modules/apps/setup-stamp"
import { invalidateDimensionCatalog } from "~/modules/permissions/dimension-catalog"
import {
  assertRlsManagementAllowed,
  declaredGrantableScopes,
  forceRlsStatements,
  generateRlsPolicySql,
  migrationGovernedTables,
  rlsScopeEntityForTable,
  tablesUnreachableByGrantableScopes,
} from "~/modules/permissions/rls-generator"
import { invalidateScopeCatalog } from "~/modules/permissions/scope-catalog"
import { registerAppSlots } from "~/modules/slots/registry"
import { declareWebhookHealth, forgetWebhookHealth } from "~/modules/webhooks/ingest-health"
import {
  parseUpstreamProbeResult,
  reportUpstreamActivity,
  reportUpstreamProbeFailure,
} from "~/modules/webhooks/upstream-activity"

const appRegistrationPromises = new Map<string, Promise<void>>()

export interface AppDescriptor {
  name: string
  version: string
  [key: string]: any
}

/**
 * Sandboxed manifest jobs run WITHOUT an ambient transaction by default: the
 * worker hands the handler an RlsSession (`_session`) and the session bridge
 * opens one short RLS transaction per bridge call, so a job never pins a pool
 * connection -- or holds a row lock -- across its sandboxed network I/O (see
 * infra/jobs/job-context.ts for the incident). `atomic: true` on the job's
 * manifest declaration keeps the legacy whole-run transaction (`_tx`) for jobs
 * whose failure paths rely on whole-run rollback (gap-free numbering, an
 * all-or-nothing snapshot rewrite) -- the same escape hatch tools have.
 */
/** True when one of the app's entities declares a `fileParent`. */
function declaresFileParent(desc: AppDescriptor): boolean {
  const entities: Record<string, unknown> | undefined = desc.entities
  return Object.values(entities ?? {}).some((e) => manifestFileParentOf(desc, e) !== undefined)
}

function jobTxMode(jobDef: { atomic?: boolean }): "ambient" | "session" {
  return jobDef.atomic === true ? "ambient" : "session"
}

/**
 * Store what an app's webhook-health probe job (manifest `webhookHealth.probe`)
 * saw of its sender (modules/webhooks/ingest-health.ts). A result that is not a
 * report (`{ probed: false, reason }`, or anything malformed) is logged and
 * dropped: if that persists the app is listed as a stale probe, never read as a
 * quiet sender. A Redis failure never fails the job run itself.
 */
export async function recordUpstreamProbeResult(
  appName: string,
  orgId: string,
  jobName: string,
  result: unknown,
): Promise<void> {
  const parsed = parseUpstreamProbeResult(result)
  if (!parsed) {
    const reason =
      result && typeof result === "object" && "reason" in result
        ? String((result as { reason: unknown }).reason)
        : undefined
    log.warn({ app: appName, job: jobName, orgId, reason }, "upstream probe returned no report")
    try {
      await reportUpstreamProbeFailure(appName, orgId, reason ?? "the probe returned no report")
    } catch (err) {
      log.error({ err, app: appName, job: jobName, orgId }, "upstream probe failure not stored")
    }
    return
  }
  try {
    await reportUpstreamActivity(appName, orgId, parsed.activityAtMs)
  } catch (err) {
    log.error({ err, app: appName, job: jobName, orgId }, "upstream probe report not stored")
  }
}

/**
 * The person a job's approval request is filed under. `approval_requests.requested_by` is a user,
 * and a scheduled job runs as nobody, so the app may name one (`on_behalf_of`, e.g. the admin who
 * switched the feature on) and the kernel checks they are an active member of the org; otherwise
 * the org's earliest active user stands in (the webhook `requiresUserActor` precedent). The
 * requester never decides it: approvers are whoever holds the tool's approve scope.
 */
export async function resolveJobApprovalRequester(
  orgId: string,
  onBehalfOf: unknown,
): Promise<string> {
  const { withPrivilegedDb } = await import("~/db/privileged")
  const { extractRows } = await import("~/db")
  const { sql: dsql } = await import("drizzle-orm")
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const rows = await withPrivilegedDb(orgId, "job-approval-requester", async (tx) => {
    if (typeof onBehalfOf === "string" && UUID_RE.test(onBehalfOf)) {
      const named = extractRows<{ id: string }>(
        await tx.execute(
          dsql`SELECT id::text AS id FROM ${dsql.raw(schemaRef("kernel"))}.users WHERE id = ${onBehalfOf} AND org_id = ${orgId} AND status = 'active' LIMIT 1`,
        ),
      )
      if (named.length > 0) return named
    }
    return extractRows<{ id: string }>(
      await tx.execute(
        dsql`SELECT id::text AS id FROM ${dsql.raw(schemaRef("kernel"))}.users WHERE org_id = ${orgId} AND status = 'active' ORDER BY created_at ASC LIMIT 1`,
      ),
    )
  })
  const id = rows[0]?.id
  if (!id) throw new Error("no active user in the organisation to file this approval request under")
  return id
}

/**
 * May this app's sandboxed code be handed a bridge over a privileged (RLS-bypassing)
 * transaction? Only when the platform vouches for the code: an in-tree or trusted app,
 * or an install that is the image's own catalog artifact. A third-party install, signed
 * by a trusted publisher or not, always runs under RLS: a bridge over a privileged
 * transaction would let its code read any row of the org through the generic bridge
 * methods (files, users, settings) whose visibility checks are RLS reads.
 */
export function hasPrivilegedBridge(desc: object): boolean {
  const d = desc as { trusted?: unknown; _firstParty?: unknown }
  return d.trusted !== false || d._firstParty === true
}

/** Bridge for a manifest job run: session-owned per-call transactions when the
 *  worker handed over `_session`, else the legacy ambient `_tx` bridge. */
export function buildJobBridge(
  appName: string,
  actorId: string,
  jobOrgId: string,
  payload: { _tx?: unknown; _session?: unknown },
  bridgeManifest: any,
  callerScopes: string[] | undefined,
): Record<string, any> {
  // `ctx.requestApproval` from a job: a scheduled job may only ASK (an approval request for one
  // of its own app's tools, re-run with the payload once a person approves); it never decides.
  const bridgeOptions = {
    requestApprovalImpl: async (input: {
      tool_name: string
      summary: string
      summary_detail?: {
        subtitle?: string
        lines?: string[]
        links?: Array<{ label: string; app: string; entityType: string; entityId: string }>
      }
      current_payload: unknown
      editable_fields?: string[]
    }) => {
      const colon = input.tool_name.indexOf(":")
      const target = colon === -1 ? appName : input.tool_name.slice(0, colon)
      if (target !== appName) {
        throw new Error("a job may only request approval for one of its own app's tools")
      }
      const requestedBy = await resolveJobApprovalRequester(
        jobOrgId,
        (input as { on_behalf_of?: unknown }).on_behalf_of,
      )
      const { createHandlerApprovalRequest } = await import("~/modules/apps/execute-tool")
      return createHandlerApprovalRequest({
        orgId: jobOrgId,
        requestedBy,
        actorScopes: [],
        defaultAppName: appName,
        origin: "system",
        input,
      })
    },
  }
  if (payload._session) {
    return createSessionRpcBridge(
      appName,
      actorId,
      jobOrgId,
      payload._session as never,
      bridgeManifest,
      callerScopes,
      undefined,
      undefined,
      bridgeOptions as never,
    )
  }
  return createSandboxRpcBridge(
    appName,
    actorId,
    jobOrgId,
    payload._tx as never,
    bridgeManifest,
    callerScopes,
    undefined,
    undefined,
    bridgeOptions as never,
  )
}

/**
 * Why an app did not load for an org, persisted beside its `kernel.apps` status
 * `error` (migration 0212) so the App store says it after a restart too: its
 * manifest failed the app contract, or its registration threw.
 */
export type AppProblemCode = "manifest_invalid" | "registration_failed"

export interface AppProblem {
  code: AppProblemCode
  message: string
}

/**
 * The app contract's verdict on a manifest, by its exact JSON. The contract is a
 * pure function of the manifest, and its tool checks compile an ajv validator per
 * tool (`defaultFillerCompileError`): judged again for every org's first touch,
 * that compile was most of an org's setup CPU, so a burst of first touches
 * queued on it.
 *
 * The cleaned manifest is SHARED by every org that registers it, deep-frozen. A
 * copy per org (a structuredClone at each first touch) was most of what a live
 * org cost the process: every registry entry an app writes points into its
 * manifest (tool descriptions, parameter schemas, scopes, entity and view
 * definitions), so each org held its own few megabytes of identical objects
 * until its runtime was released. Frozen, a registration step that writes into
 * its manifest throws instead of reaching the other orgs' registries.
 */
interface ManifestVerdict {
  success: boolean
  data?: unknown
  error?: string
}
/**
 * The latest verdict per app name, with the JSON it judged. One per app: a
 * replaced version's manifest (and what registries built from it) is freed
 * once no org registers it any more, instead of staying cached beside the new
 * one. Orgs on two versions at once (mid-activation) re-judge on each switch.
 */
const manifestVerdicts = new Map<string, { json: string; verdict: ManifestVerdict }>()
const MANIFEST_VERDICTS_MAX = 256
const manifestVerdictStats = { judged: 0 }

/** Test seam: how many manifests the app contract judged (verdict cache misses). */
export const ManifestVerdictTestAccess = {
  judged: (): number => manifestVerdictStats.judged,
}

function manifestContractResult(
  appName: string,
  json: string,
): { success: boolean; data?: any; error?: string } {
  const cached = manifestVerdicts.get(appName)
  let verdict = cached?.json === json ? cached.verdict : undefined
  if (!verdict) {
    manifestVerdictStats.judged++
    // Ajv's compiled validators can mutate their input (`useDefaults`, coercion):
    // the input is a fresh parse, never shared.
    const judged = validateAppManifest(JSON.parse(json))
    verdict = {
      success: judged.success,
      error: judged.error,
      ...(judged.success ? { data: deepFreeze(structuredClone(judged.data)) } : {}),
    }
    if (manifestVerdicts.size >= MANIFEST_VERDICTS_MAX) manifestVerdicts.clear()
    manifestVerdicts.set(appName, { json, verdict })
  }
  return verdict.success
    ? { success: true, data: verdict.data }
    : { success: false, error: verdict.error }
}

/**
 * The shared, frozen manifest a registration descriptor was cleaned from
 * (`validateForRegistration`), under a symbol so no manifest can carry it.
 */
const SHARED_MANIFEST = Symbol("liaison.sharedManifest")

/**
 * What registration builds from an app's manifest that does not depend on the
 * org: the bridge manifest, each tool's registry entry, the settings entry.
 * Built at the first org's registration and reused, the same objects, by every
 * other org that registers the same manifest with the same install facts
 * (`variant`). Keyed weakly by the shared manifest, so a manifest the verdict
 * cache dropped takes its projection with it.
 */
interface SharedAppProjection {
  variant: string
  manifestForBridge?: ReturnType<typeof buildManifestForBridge> | null
  tools: Map<string, Record<string, unknown>>
  settings?: { value: ReturnType<typeof buildAppSettingsEntry> }
}
const sharedProjections = new WeakMap<object, SharedAppProjection>()

/**
 * The minimal manifest the RPC bridge reads for tools, events and jobs.
 * Mirrored by modules/apps/bridge-manifest.ts (the CLI's installed import
 * kinds, which never register): keep the two field lists in step.
 */
function buildManifestForBridge(desc: AppDescriptor, declaredCapabilities: string[]) {
  return {
    ...((desc as any).sendGuardProviders
      ? { sendGuardProviders: (desc as any).sendGuardProviders }
      : {}),
    ...((desc as any).approvalRoute ? { approvalRoute: (desc as any).approvalRoute } : {}),
    ...(Array.isArray((desc as any).contextProviders)
      ? { contextProviders: (desc as any).contextProviders }
      : {}),
    name: desc.name,
    schema: (desc as any).schema ?? {},
    events: (desc as any).events ?? {},
    connections: (desc as any).connections ?? {},
    network: (desc as any).network ?? {},
    capabilities: declaredCapabilities,
    // I9 — carry the manifest's declared scope set into the bridge so
    // `grants_setUserScopes` can intersect app-issued grants against
    // the app's declared ceiling. Without this the bridge sees
    // `manifest.scopes === undefined` and the intersection check is
    // inert (an app could grant any in-namespace scope).
    scopes: Array.isArray((desc as any).scopes) ? ((desc as any).scopes as string[]) : [],
    // Carry declared cross-app calls into the bridge: the sandbox
    // `executeTool` K4 envelope translation keys off this being
    // non-empty. Dropping it makes a Phase-17+ app (invoicing/boxtal)
    // that expects `{ status, result }` silently observe the legacy
    // `{ data }` shape and misread every cross-app result.
    cross_app_calls: Array.isArray((desc as any).cross_app_calls)
      ? ((desc as any).cross_app_calls as Array<{ target: string; reason: string }>)
      : [],
  }
}

/** The settings registry entry `desc`'s manifest `settings` derive, or undefined for none. */
function buildAppSettingsEntry(desc: AppDescriptor) {
  const manifestSettings = desc.settings
    ? buildManifestSettingsEntry(appSettingsSchema.parse(desc.settings), {
        app: desc.name,
        connections: desc.connections,
      })
    : undefined
  const orgSchema = manifestSettings ? namespaceSchemaFor(manifestSettings, "org") : undefined
  const userSchema = manifestSettings ? namespaceSchemaFor(manifestSettings, "user") : undefined
  const userDefaults = manifestSettings ? namespaceDefaultsFor(manifestSettings, "user") : undefined
  if (!orgSchema && !userSchema && !userDefaults && !manifestSettings) return undefined
  return { orgSchema, userSchema, userDefaults, manifestSettings }
}

/** The org-independent projection of `desc`, or null when it has no shared manifest. */
function sharedProjectionOf(desc: AppDescriptor): SharedAppProjection | null {
  const shared = (desc as unknown as Record<symbol, unknown>)[SHARED_MANIFEST]
  if (!shared || typeof shared !== "object") return null
  const d = desc as unknown as Record<string, unknown>
  const variant = JSON.stringify([
    d._format ?? null,
    d._bundlePath ?? null,
    d.trusted ?? null,
    d._firstParty ?? null,
    d._publisherSigned ?? null,
    d._installed ?? null,
  ])
  let projection = sharedProjections.get(shared)
  if (!projection || projection.variant !== variant) {
    projection = { variant, tools: new Map() }
    sharedProjections.set(shared, projection)
  }
  return projection
}

/** Freeze `value` and every object below it, in place. */
function deepFreeze<T>(value: T): T {
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const o = stack.pop()
    if (o === null || typeof o !== "object" || Object.isFrozen(o)) continue
    Object.freeze(o)
    for (const k of Object.keys(o)) stack.push((o as Record<string, unknown>)[k])
  }
  return value
}

/** Long validator output is cut: the full text is in the server log. */
const MAX_PROBLEM_MESSAGE = 1000

/**
 * Validate one descriptor for registration in `orgId`: the app contract and the
 * host API range. A refused app is recorded in the errored state with its reason
 * and comes back as the problem; a valid one comes back cleaned for registration.
 */
async function validateForRegistration(
  desc: AppDescriptor,
  orgId: string,
): Promise<{ ok: true; desc: AppDescriptor } | { ok: false; problem: AppProblem }> {
  const isManifest = (desc as any)._format === "manifest"
  // Strip metadata fields before validation (manifest schema has additionalProperties: false)
  const {
    _format,
    _bundlePath,
    _uiBundlePath,
    _oauthClientResolvers,
    _bridgeExtension,
    _registerHostTools,
    _firstParty,
    _publisherSigned,
    _installed,
    ...manifestOnly
  } = desc as any
  // Deep-clone the manifest before validation. Ajv's compiled validators
  // can mutate input through `useDefaults`/coercion paths, and the spread
  // above is a shallow copy — nested objects (schema.conversations.fields.*)
  // remain shared with the module-cached JSON import, so a downstream
  // mutation in any test poisons every subsequent registerApps call.
  // For skills that ship lazy body loaders (`body: () => Promise<string>`),
  // JSON-cloning would drop the function and the manifest would fail the
  // "body required, string" check. Substitute a placeholder string for
  // those bodies pre-clone so the validator sees a shape-correct input;
  // the real body is resolved later by skillRegistry.set.
  let preClone = manifestOnly
  if (isManifest && manifestOnly?.skills) {
    const skillsClone: Record<string, unknown> = {}
    let touched = false
    for (const [name, def] of Object.entries(manifestOnly.skills as Record<string, any>)) {
      if (typeof def?.body === "function") {
        skillsClone[name] = { ...def, body: "<lazy-body-loader>" }
        touched = true
      } else {
        skillsClone[name] = def
      }
    }
    if (touched) preClone = { ...manifestOnly, skills: skillsClone }
  }
  const result = isManifest
    ? manifestContractResult(String(desc.name ?? ""), JSON.stringify(preClone))
    : validateAppDescriptor(desc)
  if (!result.success) {
    // The app is NOT loaded: its tools, jobs and webhooks are absent until a
    // version that meets this platform's contract is installed. A version
    // installed before a contract change lands here at every boot (the boot
    // catalog reconcile upgrades first-party apps before registering, so a
    // first-party app reaching this line had its upgrade fail or has no newer
    // catalog version), so the line names the version and the way out.
    log.error(
      {
        app: desc.name,
        version: desc.version,
        error: result.error,
        action:
          _installed === true
            ? `Install a version of ${desc.name} built for this platform: ${desc.name} ${desc.version} does not meet its app contract (a first-party app reinstalls from the catalog, POST /api/apps/catalog/${desc.name}/install)`
            : `Fix the ${desc.name} ${desc.version} manifest: it does not meet this platform's app contract`,
      },
      "Invalid app descriptor",
    )
    // The App store shows it as "Needs attention: manifest invalid" with this
    // reason (STO-09), instead of the app silently missing its tools.
    const problem: AppProblem = {
      code: "manifest_invalid",
      message: result.error ?? "The manifest does not meet the app contract",
    }
    if (typeof desc.name === "string" && desc.name.length > 0) {
      await persistAppErrorState(orgId, desc.name, String(desc.version ?? ""), problem)
    }
    return { ok: false, problem }
  }
  // Tool keys that narrow a scope-taint refusal count only for an app the platform vouches
  // for (contract.ts): any other app declaring one is not loaded, same errored state.
  const firstPartyKeyErrors =
    isManifest && !hasPrivilegedBridge(desc) ? firstPartyOnlyToolKeyErrors(manifestOnly) : []
  if (firstPartyKeyErrors.length > 0) {
    const problem: AppProblem = {
      code: "manifest_invalid",
      message: firstPartyKeyErrors.join("; "),
    }
    log.error(
      { app: desc.name, version: desc.version, error: problem.message },
      "Invalid app descriptor",
    )
    await persistAppErrorState(orgId, String(desc.name ?? ""), String(desc.version ?? ""), problem)
    return { ok: false, problem }
  }
  // An app that needs a host API this server does not provide is not loaded
  // either (S3): same errored state, with the reason the App store shows.
  const hostProblem = hostApiIncompatibility({
    name: desc.name,
    version: String(desc.version ?? ""),
    host: typeof manifestOnly?.host === "string" ? manifestOnly.host : undefined,
  })
  if (hostProblem) {
    log.error(
      { app: desc.name, version: desc.version, error: hostProblem },
      "App needs a newer host API",
    )
    const problem: AppProblem = { code: "manifest_invalid", message: hostProblem }
    await persistAppErrorState(orgId, desc.name, String(desc.version ?? ""), problem)
    return { ok: false, problem }
  }
  // If skills had lazy body loaders, restore the originals — `result.data`
  // carries the validation placeholder strings, and the skill register
  // step at line ~800 dispatches on `typeof body === "function"` to call
  // the loader. Without restore, the lazy loaders are lost and we
  // register the placeholder text as the skill body.
  const restoredSkills =
    isManifest && manifestOnly?.skills
      ? Object.fromEntries(
          Object.entries(manifestOnly.skills as Record<string, any>).map(([n, d]) => [
            n,
            typeof d?.body === "function" ? d : ((result.data as any).skills?.[n] ?? d),
          ]),
        )
      : (result.data as any).skills
  return {
    ok: true,
    desc: {
      ...result.data,
      ...(restoredSkills ? { skills: restoredSkills } : {}),
      _format,
      _bundlePath,
      _uiBundlePath,
      _oauthClientResolvers,
      // _bridgeExtension is a FUNCTION factory — it must be carried through the
      // validate-strip (JSON.stringify would drop it) and restored here, or the
      // app's RPC bridge methods (e.g. google-drive's drive_export) silently
      // never register and its sandboxed handlers fail with "not a function".
      _bridgeExtension,
      // Same (a function): a built-in app's host-side tools, the ones a manifest
      // cannot declare (an `approveScope` other than `<app>:approve`).
      _registerHostTools,
      // Set by init.ts discovery, never by the manifest: lets a sandboxed
      // first-party app's `readOnly` count (see the tool projection below).
      _firstParty,
      // Same: the operator's own install-time voucher (a verified trusted-publisher
      // signature on this artifact), which also lets `readOnly` count.
      _publisherSigned,
      // Same: marks a runtime install (third-party rules apply unless vouched for).
      _installed,
      // The shared manifest this was cleaned from: what registration builds
      // from it is built once and shared across orgs (sharedProjectionOf).
      ...(isManifest ? { [SHARED_MANIFEST]: result.data } : {}),
    } as AppDescriptor,
  }
}

/** How `registerApps` treats the org's persistent rows. */
export interface RegisterAppsOptions {
  /**
   * The org's setup stamp matches (setup-stamp.ts): its `kernel.apps` rows,
   * settings defaults and manifest roles are current, so the registration
   * writes none of them. The schema DDL and the in-memory registration run as
   * usual.
   */
  skipOrgRows?: boolean
  /**
   * Runs a transaction that may change an app schema (DDL on the tables every
   * org shares, which concurrent registrations have deadlocked on): the serial
   * lane of `setUpOrg` (registration-lane.ts). Given, an org whose app schemas
   * are already current writes its rows beside other orgs' setups, and only a
   * registration that has to change a schema waits in the lane; absent, every
   * registration runs inline.
   */
  serializeDdl?: <T>(task: () => Promise<T>) => Promise<T>
}

/**
 * Register the apps for `orgId`. Returns the apps that did not register: refused
 * by validation, rejected by dependency resolution, or failed in registration
 * (each recorded as the app's errored state where it has a name). A fatal
 * registration error still throws.
 */
export async function registerApps(
  descriptors: AppDescriptor[],
  orgId: string,
  opts: RegisterAppsOptions = {},
): Promise<{ failedApps: string[] }> {
  // A lookup that misses for this org while it registers is not a read before
  // setup (org-registry-guard.ts).
  orgsRegistering.set(orgId, (orgsRegistering.get(orgId) ?? 0) + 1)
  try {
    // The tenant boundary (app-org-scope.ts): another org's custom app never
    // enters this org's registries, so none of its tools, views, routes,
    // webhooks, MCP tools, jobs or event subscriptions exist here.
    const visible = await filterAppsVisibleToOrg(descriptors, orgId, (d) => d.name)
    return await registerAppsMarked(visible, orgId, opts)
  } finally {
    const depth = (orgsRegistering.get(orgId) ?? 1) - 1
    if (depth > 0) orgsRegistering.set(orgId, depth)
    else orgsRegistering.delete(orgId)
  }
}

async function registerAppsMarked(
  descriptors: AppDescriptor[],
  orgId: string,
  opts: RegisterAppsOptions,
): Promise<{ failedApps: string[] }> {
  const verificationDescriptors = descriptors.map((desc) => ({
    name: desc.name,
    dependencies: (desc as any).dependencies,
    tools: (desc as any).tools,
    _declaredToolNames: Object.keys((desc as any).tools ?? {}),
  })) as unknown as AppDescriptor[]

  const failedApps: string[] = []
  // Step 1: Validate all descriptors
  const valid: AppDescriptor[] = []
  for (const desc of descriptors) {
    const checked = await validateForRegistration(desc, orgId)
    if (checked.ok) valid.push(checked.desc)
    else failedApps.push(String(desc.name ?? ""))
  }

  // Step 2: Resolve dependencies
  const resolution = resolveAppOrder(
    valid.map((d) => ({ name: d.name, dependencies: d.dependencies })),
  )
  if (!resolution.success) {
    log.error({ error: resolution.error }, "Dependency resolution failed")
    // Filter out rejected apps
    const rejected = new Set(resolution.rejectedApps)
    const loadable = valid.filter((d) => !rejected.has(d.name))
    for (const d of valid) if (rejected.has(d.name)) failedApps.push(d.name)
    // Re-resolve without rejected
    if (loadable.length === 0) return { failedApps }
    const retry = resolveAppOrder(
      loadable.map((d) => ({ name: d.name, dependencies: d.dependencies })),
    )
    if (!retry.success) {
      failedApps.push(...loadable.map((d) => d.name))
      return { failedApps }
    }
    const order = retry.order ?? []
    failedApps.push(...loadable.filter((d) => !order.includes(d.name)).map((d) => d.name))
    failedApps.push(
      ...(await registerInOrder(
        loadable.filter((d) => order.includes(d.name)),
        order,
        orgId,
        verificationDescriptors.filter((d) => order.includes(d.name)),
        opts,
      )),
    )
    return { failedApps }
  }

  failedApps.push(
    ...(await registerInOrder(valid, resolution.order!, orgId, verificationDescriptors, opts)),
  )
  return { failedApps }
}

/**
 * Switch one org's registration of an app to `desc` (activation.ts): validate it
 * like a boot registration, then register it over the running version without a
 * gap. A refusal or a failed registration is recorded as the app's errored state
 * in the org, exactly as at boot, and comes back as the problem.
 */
export async function switchAppRegistration(
  desc: AppDescriptor,
  orgId: string,
): Promise<{ ok: true } | { ok: false; problem: AppProblem }> {
  const checked = await validateForRegistration(desc, orgId)
  if (!checked.ok) return checked
  try {
    await registerSingleApp(checked.desc, orgId, { swap: true })
    return { ok: true }
  } catch (err) {
    log.error({ app: desc.name, version: desc.version, orgId, err }, "App registration failed")
    const problem: AppProblem = {
      code: "registration_failed",
      message: describeDbError(err).message ?? String(err),
    }
    await persistAppErrorState(orgId, desc.name, String(desc.version ?? ""), problem)
    return { ok: false, problem }
  }
}

async function registerInOrder(
  descriptors: AppDescriptor[],
  order: string[],
  orgId: string,
  verificationDescriptors = descriptors,
  opts: RegisterAppsOptions = {},
): Promise<string[]> {
  const byName = new Map(descriptors.map((d) => [d.name, d]))
  const failed: string[] = []

  for (const name of order) {
    const desc = byName.get(name)
    if (!desc) continue

    try {
      const registeredNow = await registerSingleApp(desc, orgId, {
        skipOrgRows: opts.skipOrgRows,
        serializeDdl: opts.serializeDdl,
      })
      if (registeredNow) {
        log.info({ app: name, version: desc.version, orgId }, "App registered")
      }
    } catch (err) {
      if (err instanceof AppRegistrationFatalError) {
        log.error(
          { app: name, code: err.code, details: err.details },
          "App registration fatal error",
        )
        throw err
      }
      log.error({ app: name, err }, "App registration failed")
      failed.push(name)
      await persistAppErrorState(orgId, name, desc.version, {
        code: "registration_failed",
        message: describeDbError(err).message ?? String(err),
      })
    }
  }

  verifyCrossAppToolDependencies(verificationDescriptors, orgId)
  return failed
}

/**
 * Persist the errored state so the app is never silently left
 * installed-but-toolless. MUST be an upsert: a previously-registered app
 * (re-register on boot / hot-reload) already has an (org_id, name) row, so
 * a bare insert would hit `apps_org_name_idx` and — caught and ignored —
 * leave the stale `active` status in place while the app has no live tools.
 * onConflictDoUpdate flips the existing row to `error` instead.
 */
async function persistAppErrorState(
  orgId: string,
  name: string,
  version: string,
  problem: AppProblem,
): Promise<void> {
  const problemCode = problem.code
  // Redacted like an activation reason (A14): an org admin reads it. The full
  // text is in the server log.
  const { redactReason } = await import("~/modules/apps/activation")
  const redacted = redactReason(problem.message, MAX_PROBLEM_MESSAGE)
  const problemMessage = redacted
  try {
    await withPrivilegedDb(orgId, "app-register-error", (db) =>
      db
        .insert(apps)
        .values({ orgId, name, version, status: "error", problemCode, problemMessage })
        .onConflictDoUpdate({
          target: [apps.orgId, apps.name],
          set: { status: "error", version, problemCode, problemMessage, updatedAt: new Date() },
          // An Off or removed workspace state is the admin's; a failed
          // registration does not overwrite it.
          setWhere: inArray(apps.status, ["active", "error"]),
        }),
    )
    // A first row for the app: the admin's list must see it (STO-09).
    noteAppRegistered(orgId, name)
  } catch (recordErr) {
    // Failing to even record the error state is itself a degraded condition
    // an operator must see — never swallow it silently.
    log.error(
      { app: name, err: recordErr },
      "Failed to persist app error status after registration failure",
    )
  }
}

/**
 * Walks every registered descriptor's `dependencies.tools` declaration and asserts each
 * target tool was added to the in-memory `toolRegistry`. Runs once after the full batch
 * has registered so cross-app references resolve regardless of dependency order.
 */
export function verifyCrossAppToolDependencies(descriptors: AppDescriptor[], orgId: string): void {
  const descriptorsByName = new Map(descriptors.map((desc) => [desc.name, desc]))
  for (const desc of descriptors) {
    const declared = (desc as any).dependencies?.tools as string[] | undefined
    if (!declared) continue
    const requiredApps = new Set((desc as any).dependencies?.required ?? [])
    const optionalApps = new Set((desc as any).dependencies?.optional ?? [])
    for (const id of declared) {
      const [targetApp, toolName] = id.split(":")
      const targetDescriptor = descriptorsByName.get(targetApp) as any
      const optionalDependency = optionalApps.has(targetApp) && !requiredApps.has(targetApp)
      if (optionalDependency && !targetDescriptor) continue
      const targetDeclaredToolNames = targetDescriptor?._declaredToolNames as string[] | undefined
      const targetTools = targetDescriptor?.tools as Record<string, unknown> | undefined
      const existsInBatch = targetDeclaredToolNames
        ? targetDeclaredToolNames.includes(toolName)
        : targetTools
          ? Object.hasOwn(targetTools, toolName)
          : false
      const descriptorDeclaresTools =
        targetDeclaredToolNames !== undefined || targetTools !== undefined
      const existsInRegistry = descriptorDeclaresTools
        ? false
        : toolRegistry.get([orgId, targetApp, toolName])
      if (optionalDependency && !existsInBatch && !existsInRegistry) continue
      if (!existsInBatch && !existsInRegistry) {
        throw new AppRegistrationFatalError(
          "missing_tool_dependency",
          {
            appName: desc.name,
            toolId: id,
            declaredBy: desc.name,
            targetApp,
            toolName,
            targetDescriptorKeys: targetDescriptor ? Object.keys(targetDescriptor) : [],
            targetDeclaredToolNames,
            targetToolNames: targetTools ? Object.keys(targetTools) : [],
          },
          `missing_tool_dependency: ${id} declared by ${desc.name} but not present in ${targetApp}'s tool registry`,
        )
      }
    }
  }
}

/** FNV-1a 32-bit hash — maps a string to a stable int32 for PostgreSQL advisory locks. */
function fnv1a32(str: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 1 // Convert to non-negative int (pg advisory lock needs int8, but 32-bit is fine)
}

function flattenRoleScopes(
  roles: Record<string, { extends?: string; scopes: string[] }>,
  name: string,
  visited = new Set<string>(),
): string[] {
  if (visited.has(name)) return []
  visited.add(name)
  const def = roles[name]
  if (!def) return []
  const own = new Set(def.scopes)
  if (def.extends) for (const s of flattenRoleScopes(roles, def.extends, visited)) own.add(s)
  return Array.from(own).sort()
}

/** `(gen_random_uuid(), roleId, scope), ...` rows for a role_scope_grants INSERT, in `scopes` order. */
function scopeGrantValues(roleId: string, scopes: string[]): SQL {
  return drizzleSql.join(
    scopes.map((scope) => drizzleSql`(gen_random_uuid(), ${roleId}, ${scope})`),
    drizzleSql`, `,
  )
}

/**
 * Grant `scopes` (sorted, distinct) to a role in one statement, keeping the
 * grants it already holds; returns the scopes that were new, in `scopes` order.
 */
async function insertMissingScopeGrants(
  tx: any,
  roleId: string,
  scopes: string[],
): Promise<string[]> {
  if (scopes.length === 0) return []
  const grantsTable = drizzleSql.raw(`${schemaRef("kernel")}.role_scope_grants`)
  const inserted = new Set(
    extractRows<{ scope: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${grantsTable} (id, role_id, scope)
        VALUES ${scopeGrantValues(roleId, scopes)}
        ON CONFLICT (role_id, scope) DO NOTHING
        RETURNING scope
      `),
    ).map((r) => r.scope),
  )
  return scopes.filter((scope) => inserted.has(scope))
}

export async function seedManifestRoles(
  tx: any,
  orgId: string,
  appName: string,
  roles: Record<string, { description?: string; extends?: string; scopes: string[] }>,
): Promise<void> {
  const rolesTable = drizzleSql.raw(`${schemaRef("kernel")}.roles`)
  const grantsTable = drizzleSql.raw(`${schemaRef("kernel")}.role_scope_grants`)
  for (const [roleName, def] of Object.entries(roles)) {
    const namespaced = `${appName}.${roleName}`
    const flat = flattenRoleScopes(roles, roleName)
    const result = await tx.execute(drizzleSql`
      INSERT INTO ${rolesTable} (id, org_id, name, description, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, ${namespaced}, ${def.description ?? null}, now(), now())
      ON CONFLICT (org_id, name) DO UPDATE
        SET description = EXCLUDED.description, updated_at = now()
      RETURNING id
    `)
    const rows = Array.isArray(result) ? result : ((result as any).rows ?? [])
    const id = rows[0]?.id
    if (!id) continue
    const deleted = await tx.execute(
      drizzleSql`DELETE FROM ${grantsTable} WHERE role_id = ${id} RETURNING scope`,
    )
    const deletedRows: Array<{ scope: string }> = Array.isArray(deleted)
      ? deleted
      : ((deleted as any).rows ?? [])
    const previous = new Set(deletedRows.map((r) => r.scope))
    if (flat.length > 0) {
      await tx.execute(drizzleSql`
        INSERT INTO ${grantsTable} (id, role_id, scope)
        VALUES ${scopeGrantValues(id, flat)}
      `)
    }
    // A reseed that adds or drops a scope changes every current member's
    // effective scope; an identical reseed changes nothing.
    if (previous.size !== flat.length || flat.some((s) => !previous.has(s))) {
      // Delivery carrier: `resolveGrantInvalidations` resolves this role's
      // current members and their thread ids from this event plus the
      // database at delivery time, so queuing it in the SAME transaction as
      // the write, exactly like the role-level paths in permissions/roles.ts,
      // is what delivers the invalidation instead of waiting for the org's
      // next unrelated permission event (or never arriving).
      const added = flat.filter((s) => !previous.has(s))
      const removed = [...previous].filter((s) => !flat.includes(s))
      await tx.queueEvent({
        app: "kernel",
        entity: "role_scope",
        action: added.length > 0 ? "grant" : "revoke",
        entityId: id,
        orgId,
        data: { roleId: id, scopesAdded: added, scopesRemoved: removed },
      })
    }
  }
}

/**
 * The app's "standard member" scope set for the auto-maintained Full Member role.
 *
 * Prefer the role literally named `member` (the conventional entry-level write
 * tier). Apps that don't declare one (e.g. `tickets`, whose tiers are
 * `support` / `support_lead` / `admin`) fall back to their lowest-privilege
 * non-admin role — the base tier — so Full Member gets usable access to every
 * app without inheriting lead/curator-tier powers (e.g. `tickets:accounts:admin`
 * lives on `support_lead`, not the base `support` tier). The `admin` role is
 * always excluded. Apps can make this explicit simply by naming their base
 * write role `member`.
 */
function baselineMemberScopes(
  roles: Record<string, { extends?: string; scopes: string[] }>,
): string[] {
  if (roles.member) return flattenRoleScopes(roles, "member")
  const nonAdmin = Object.keys(roles)
    .filter((n) => n !== "admin")
    .map((n) => ({ name: n, scopes: flattenRoleScopes(roles, n) }))
    .sort((a, b) => a.scopes.length - b.scopes.length || a.name.localeCompare(b.name))
  return nonAdmin[0]?.scopes ?? []
}

/** Reserved name of the auto-maintained composite role. */
export const FULL_MEMBER_ROLE_NAME = "Full Member"
const FULL_MEMBER_ROLE_DESCRIPTION =
  "Standard member access to every installed app, automatically granted each " +
  "app's base member tier. System-managed: scopes update as apps are installed. " +
  "Excludes admin, lead and curator tiers."

/**
 * The role names an app's registration creates in an org from its manifest
 * `roles`: one `<app>.<role>` per manifest role (`seedManifestRoles`) and, when
 * the app has a non-empty base member tier, the shared "Full Member" role
 * (`extendFullMemberRole`). Lets a caller know the roles an org WILL have once
 * an app registers, before it does.
 */
export function rolesSeededByRegistration(appName: string, declared: unknown): string[] {
  if (!declared || typeof declared !== "object") return []
  const roles = declared as Record<string, { extends?: string; scopes: string[] }>
  const names = Object.keys(roles).map((role) => `${appName}.${role}`)
  if (baselineMemberScopes(roles).length > 0) names.push(FULL_MEMBER_ROLE_NAME)
  return names
}

/**
 * Auto-maintained "Full Member" composite role.
 *
 * Liaison ships kernel-only `member`/`viewer` defaults plus one `<app>.member` /
 * `<app>.admin` role per app, but nothing that spans EVERY app. Self-hosters
 * hand-build an umbrella "full member" role — and every time a NEW app is
 * installed, that umbrella silently misses it until an admin edits it (the
 * 2026-07-03 calendar-access gap). This closes the hole: on every app
 * registration we ensure a system-managed "Full Member" role holds the app's
 * standard non-admin scopes, so full members gain access to new apps automatically.
 *
 * Semantics:
 *  - Grants each app's standard member tier (see `baselineMemberScopes`) — the
 *    `member` role, or the lowest non-admin tier for apps without one. App-admin
 *    and lead/curator tiers stay opt-in. `clevel` and other cross-cutting scopes
 *    are never app-role scopes, so C-Level document access is structurally
 *    excluded here.
 *  - Additive only: grants missing scopes, never revokes — so an admin's manual
 *    additions and an app's scope history survive (uninstall/downgrade pruning is
 *    a separate concern).
 *  - Adopts an existing same-named role (flips it system-managed) so a hand-built
 *    "Full Member" is picked up and completed in place.
 *  - Bumps permission_version for assigned members when new scopes land, so live
 *    sessions pick up the new app within the auth-cache TTL.
 */
export async function extendFullMemberRole(
  tx: any,
  orgId: string,
  roles: Record<string, { extends?: string; scopes: string[] }>,
): Promise<void> {
  const baseline = baselineMemberScopes(roles)
  if (baseline.length === 0) return
  const scopes = new Set(baseline)

  const rolesTable = drizzleSql.raw(`${schemaRef("kernel")}.roles`)
  const usersTable = drizzleSql.raw(`${schemaRef("kernel")}.users`)
  const userRolesTable = drizzleSql.raw(`${schemaRef("kernel")}.user_roles`)

  // Ensure the system-managed role exists (adopting a hand-built same-named one).
  const roleRes = await tx.execute(drizzleSql`
    INSERT INTO ${rolesTable} (id, org_id, name, description, system_managed, created_at, updated_at)
    VALUES (gen_random_uuid(), ${orgId}, ${FULL_MEMBER_ROLE_NAME}, ${FULL_MEMBER_ROLE_DESCRIPTION}, true, now(), now())
    ON CONFLICT (org_id, name) DO UPDATE SET system_managed = true, updated_at = now()
    RETURNING id
  `)
  const roleRows = Array.isArray(roleRes) ? roleRes : ((roleRes as any).rows ?? [])
  const roleId = roleRows[0]?.id
  if (!roleId) return

  // Additive grant; count how many scopes are actually new.
  const addedScopes = await insertMissingScopeGrants(tx, roleId, Array.from(scopes).sort())
  const added = addedScopes.length

  // Only touch live sessions when the scope set actually changed.
  if (added > 0) {
    await tx.execute(drizzleSql`
      UPDATE ${usersTable}
      SET permission_version = permission_version + 1
      WHERE id IN (
        SELECT user_id FROM ${userRolesTable} WHERE role_id = ${roleId} AND org_id = ${orgId}
      )
    `)
    // Delivery carrier, same reasoning as seedManifestRoles: queue the
    // permission event in this same transaction so `resolveGrantInvalidations`
    // can deliver it on commit rather than waiting for the org's next
    // unrelated permission event.
    await tx.queueEvent({
      app: "kernel",
      entity: "role_scope",
      action: "grant",
      entityId: roleId,
      orgId,
      data: { roleId, scopesAdded: addedScopes },
    })
  }
}

/** Name of the kernel member preset seeded by `seedDefaultRoles`. */
const KERNEL_MEMBER_PRESET = "member"

/**
 * Hand the org's kernel `member` preset the scopes an app declares in
 * `memberPresetScopes` (validated to sit inside the app's own `member` tier).
 *
 * The kernel `DEFAULT_ROLES` stay kernel-only: apps register their scopes after
 * the org is seeded, so an app that wants every member to hold one of its scopes
 * grants it here, at registration. Unlike `extendFullMemberRole` this runs only
 * on the app's FIRST install in the org (the caller checks), so an admin who
 * later removes the scope from the preset is not overruled by the next boot.
 * A missing preset (renamed or deleted by an admin) is left alone.
 */
export async function grantMemberPresetScopes(
  tx: any,
  orgId: string,
  scopes: unknown,
): Promise<void> {
  if (!Array.isArray(scopes) || scopes.length === 0) return
  const rolesTable = drizzleSql.raw(`${schemaRef("kernel")}.roles`)
  const usersTable = drizzleSql.raw(`${schemaRef("kernel")}.users`)
  const userRolesTable = drizzleSql.raw(`${schemaRef("kernel")}.user_roles`)
  const roleRows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${rolesTable}
      WHERE org_id = ${orgId} AND name = ${KERNEL_MEMBER_PRESET} AND system_managed = false
    `),
  )
  const roleId = roleRows[0]?.id
  if (!roleId) return
  const wanted = [...new Set(scopes.filter((s): s is string => typeof s === "string"))].sort()
  const addedScopes = await insertMissingScopeGrants(tx, roleId, wanted)
  if (addedScopes.length === 0) return
  await tx.execute(drizzleSql`
    UPDATE ${usersTable}
    SET permission_version = permission_version + 1
    WHERE id IN (
      SELECT user_id FROM ${userRolesTable} WHERE role_id = ${roleId} AND org_id = ${orgId}
    )
  `)
  // Same delivery carrier as extendFullMemberRole.
  await tx.queueEvent({
    app: "kernel",
    entity: "role_scope",
    action: "grant",
    entityId: roleId,
    orgId,
    data: { roleId, scopesAdded: addedScopes },
  })
}

function sortEntitiesByFk(schema: Record<string, any>): Array<[string, any]> {
  const names = Object.keys(schema)
  const known = new Set(names)
  const deps = new Map<string, Set<string>>()
  for (const name of names) {
    const set = new Set<string>()
    const fields = (schema[name] as { fields?: Record<string, any> }).fields ?? {}
    for (const def of Object.values(fields)) {
      if (typeof def !== "object" || def === null) continue
      const refs = (def as { references?: { table?: string; schema?: string } }).references
      if (!refs?.table) continue
      if (refs.schema && refs.schema !== "") continue // cross-schema refs don't affect intra-app order
      if (refs.table === name) continue // self-reference is fine for CREATE TABLE
      if (known.has(refs.table)) set.add(refs.table)
    }
    deps.set(name, set)
  }
  const sorted: string[] = []
  const visited = new Set<string>()
  const inProgress = new Set<string>()
  function visit(name: string): void {
    if (visited.has(name)) return
    if (inProgress.has(name)) return
    inProgress.add(name)
    for (const d of deps.get(name) ?? new Set<string>()) visit(d)
    inProgress.delete(name)
    visited.add(name)
    sorted.push(name)
  }
  for (const n of names) visit(n)
  return sorted.map((n) => [n, schema[n]])
}

/**
 * Summarizer trust carve-out.
 *
 * Every installed manifest app is `trusted: false` by construction (init.ts:
 * process-isolated, untrusted worker pool), so its declared summarizers run in
 * the QuickJS sandbox with an EMPTY bridge. A summarizer that needs I/O to
 * build its preview (for example a read of the record's CURRENT state, to show
 * a before/after diff of an irreversible write) degrades there to "preview
 * unavailable", and the approver of that write sees only raw params.
 *
 * `LIAISON_TRUSTED_SUMMARIZER_APPS` (comma-separated app names) lets an
 * operator run the DECLARED summarizers of the named apps host-side. Default
 * EMPTY: nothing changes unless an operator opts an app in. It is meant for
 * host-authored, source-reviewed bundled apps, not a blanket trust upgrade:
 * the app's handlers stay process-isolated and `trusted: false` everywhere
 * else. Every registration through it logs a warning naming the override.
 */
export function isSummarizerTrustCarveOutAllowed(appName: string): boolean {
  const raw = process.env.LIAISON_TRUSTED_SUMMARIZER_APPS ?? ""
  const allowlist = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return allowlist.includes(appName)
}

async function loadTrustedBundleFunction(bundlePath: string, exportName: string): Promise<unknown> {
  const summarizerPath = bundlePath
    .replace(/handlers(\.[cm]?[tj]s)$/, "summarizers$1")
    .replace(/handler-bundle(\.[cm]?[tj]s)$/, "summarizers$1")
  const candidates = [...new Set([bundlePath, summarizerPath])]

  for (const candidate of candidates) {
    try {
      if (candidate !== bundlePath && !(await Bun.file(candidate).exists())) continue
      const mod = await import(pathToFileURL(candidate).href)
      const exported = mod[exportName]
      if (typeof exported === "function") return exported
    } catch (err) {
      log.debug({ err, bundlePath: candidate, exportName }, "Trusted bundle function lookup failed")
    }
  }

  throw new Error(`Export "${exportName}" not found in trusted bundle`)
}

/** Non-secret metadata handed to approval summarizers as a third argument. */
export interface SummarizerMeta {
  connectionIdentifier: string | null
  context: unknown
}

/**
 * Build the summarizer's `meta`: the app's connected-account identifier (for
 * external deep links, e.g. the Shopify admin domain) plus the optional
 * declarative hydration result (manifest `summarizerContext`: the kernel runs
 * the app's own UNGATED read tool through the standard executeTool path under
 * the CALLER's authorization). Every failure degrades to nulls — meta is an
 * enrichment, never a precondition.
 */
async function buildSummarizerMeta(
  orgId: string,
  appName: string,
  summarizerContext: { tool: string; params: Record<string, string> } | undefined,
  params: unknown,
  actor: import("~/db/rls").ActorContext | undefined,
): Promise<SummarizerMeta> {
  let connectionIdentifier: string | null = null
  try {
    const rows = extractRows<{ identifier: string | null }>(
      await withPrivilegedDb(orgId, "summarizer-connection-identifier", (db) =>
        db.execute(drizzleSql`
          SELECT identifier
          FROM ${drizzleSql.raw(`${schemaRef("kernel")}.connected_accounts`)}
          WHERE org_id = ${orgId} AND app_name = ${appName}
          ORDER BY (status = 'active') DESC, created_at DESC LIMIT 1`),
      ),
    )
    connectionIdentifier = rows[0]?.identifier ?? null
  } catch {
    /* identifier is a nicety — links degrade to in-app lists */
  }
  let context: unknown = null
  if (summarizerContext && actor) {
    try {
      const target = toolRegistry.get([orgId, appName, summarizerContext.tool])
      if (target && target.gated !== true) {
        const readPath = (obj: unknown, path: string): unknown =>
          path
            .split(".")
            .reduce<unknown>(
              (cur, key) =>
                cur && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined,
              obj,
            )
        const mapped: Record<string, unknown> = {}
        for (const [ctxParam, sourcePath] of Object.entries(summarizerContext.params)) {
          const value = readPath(params, sourcePath)
          if (value !== undefined) mapped[ctxParam] = value
        }
        const { executeTool } = await import("~/modules/apps/execute-tool")
        const res = await executeTool({
          toolName: `${appName}:${summarizerContext.tool}`,
          orgId,
          actor,
          params: mapped,
          // Internal read-only hydration for an approval card summary, not a
          // human click, an in-app agent turn, or an MCP call. gated !== true
          // above already makes this gate-harmless; "system" keeps the audit
          // label truthful too (never attributed to an agent that never ran).
          origin: "system",
        })
        context = res.data ?? null
      }
    } catch (err) {
      log.warn(
        { err, app: appName, tool: summarizerContext.tool },
        "summarizerContext hydration failed — summary proceeds unhydrated",
      )
    }
  }
  return { connectionIdentifier, context }
}

/**
 * The tables and columns an app's manifest declares that its live schema does
 * not carry. One catalog query per call, no DDL: it is the cheap probe that
 * tells the already-registered fast path whether the database still matches
 * what the in-memory registration claims.
 *
 * Only DECLARED fields are compared. Runtime-owned objects (indexes, triggers,
 * the `handle` column of a handlePrefix entity) are left to the registration
 * path itself, so a shape the manifest does not describe never forces a
 * re-register loop.
 */
export async function findDriftedSchemaObjects(
  desc: AppDescriptor,
  orgId: string,
  tx?: PrivilegedDb,
): Promise<string[]> {
  if (!desc.schema) return []
  const schemaName = validateIdentifier(schemaRef(`app_${desc.name.replace(/-/g, "_")}`))
  // pg_catalog rather than information_schema: the same facts, without the
  // privilege-filtering joins that make information_schema.columns slow on a
  // path that runs for every app on every registerApps call.
  const probe = (db: PrivilegedDb) =>
    db
      .execute(drizzleSql`
        SELECT c.relname AS table_name, a.attname AS column_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = ${schemaName} AND c.relkind = 'r'
      `)
      .then((r) => extractRows<{ table_name: string; column_name: string }>(r))
  const rows = tx
    ? await probe(tx)
    : await withPrivilegedDb(orgId, `app-schema-drift-probe:${desc.name}`, probe)
  const live = new Map<string, Set<string>>()
  for (const { table_name, column_name } of rows) {
    let cols = live.get(table_name)
    if (!cols) {
      cols = new Set()
      live.set(table_name, cols)
    }
    cols.add(column_name)
  }

  const missing: string[] = []
  for (const [entityName, entityDef] of Object.entries(
    desc.schema as Record<string, { fields?: Record<string, unknown> }>,
  )) {
    if (!entityDef?.fields) continue
    const cols = live.get(entityName)
    if (!cols) {
      missing.push(entityName)
      continue
    }
    for (const fieldName of Object.keys(entityDef.fields)) {
      const colName = fieldName.replace(/([A-Z])/g, "_$1").toLowerCase()
      if (!cols.has(colName)) missing.push(`${entityName}.${colName}`)
    }
  }
  return missing
}

/** Counters for tests: registration DDL transactions run, DDL attempts that
 *  lost a lock race (or a deadlock) and backed off, and registrations that
 *  reused an already-current schema (`appSchemaDdlReuse`). */
export const appRegistrationStats = {
  ddlTransactions: 0,
  lockTimeouts: 0,
  ddlReused: 0,
  /** `writeOrgAppRows` runs: an org's persistent app rows written (S4). */
  orgRowWrites: 0,
  /** Registrations of a set-up org that skipped the schema check (`currentAppSchemaKeys`). */
  ddlCheckSkipped: 0,
  /** Registrations served on the existing schema while its re-apply is deferred (`appDdlDeferral`). */
  ddlDeferred: 0,
}

/**
 * An app schema whose re-apply lost its locks (a lock timeout on every
 * attempt, or a deadlock) is not re-applied by every next org's registration
 * in this process: each would run the same doomed DDL, its retries and
 * back-offs, inside the one registration lane every org setup waits in, and
 * take the same locks on the tables visitors are using. That is what a deploy
 * under load did: a new build whose stamp was stale for one app re-ran its DDL
 * (and lost to a deadlock) for every visitor's org, and every org setup behind
 * it, on every new process, waited past the request deadline.
 *
 * For `cooldownMs` after such a failure, an org's registration of that app is
 * served on the schema already in place when that schema was once fully
 * applied (it carries a DDL stamp) and holds every declared table and column:
 * the org gets its declarations and rows, which is what a reuse does. The
 * re-apply is tried again by the first registration after the cool-down. A
 * schema missing a declared table or column is never served this way.
 */
export const appDdlDeferral = { cooldownMs: 5 * 60_000 }
/** When the schema DDL of a manifest key last lost its locks in this process. */
const appDdlFailedAt = new Map<string, number>()

/**
 * How the registration DDL waits for table locks. An attempt gives up a lock it
 * cannot take within `lockTimeoutMs`, rolls back and retries after a doubling
 * backoff, so readers never queue behind it. The timeout stays under Postgres'
 * default `deadlock_timeout` (1 s): in a lock cycle with a reader, the DDL
 * usually backs off before the reader's deadlock check picks the reader. Once
 * the attempts are spent, a server makes one last attempt that waits for its
 * locks, so an app upgrade on a busy table still lands; the CLI gives up.
 */
export const appDdlLockPolicy = { lockTimeoutMs: 500, maxAttempts: 8, backoffMs: 250 }

/**
 * Registering an app for an org whose app schema already carries this exact DDL
 * stamp (`appDdlStamp`) and every declared column skips the schema DDL: only
 * that org's own rows (`writeOrgAppRows`) and in-memory declarations are
 * written. The schema DDL does not depend on the org, so the result is the
 * database state of the full registration (the `schema-ddl-reuse-equivalence`
 * test proves it). A redeploy with no app change therefore takes no DDL lock:
 * the ACCESS EXCLUSIVE locks of the DDL on app tables every org shares used to
 * deadlock the jobs of the orgs already serving while the others registered.
 *
 * What the stamp cannot see, a schema object changed by hand other than a
 * dropped table or column, is repaired at the next app, code or migration
 * change rather than at every boot. Test seam: `false` forces the full DDL.
 */
export const appSchemaDdlReuse = { enabled: true }

/**
 * True when the app schema carries `stamp` and no declared table or column is
 * missing. Runs on the registration's own transaction: the probe is two
 * catalog reads, and a transaction of its own would cost more than both.
 */
async function isAppSchemaDdlCurrent(
  tx: PrivilegedDb,
  desc: AppDescriptor,
  orgId: string,
  schemaName: string,
  stamp: string,
): Promise<boolean> {
  const rows = extractRows<{ stamp: string | null }>(
    await tx.execute(drizzleSql`
      SELECT obj_description(n.oid, 'pg_namespace') AS stamp
      FROM pg_namespace n WHERE n.nspname = ${schemaName}
    `),
  )
  if (rows[0]?.stamp !== stamp) return false
  return (await findDriftedSchemaObjects(desc, orgId, tx)).length === 0
}

const APP_DDL_STAMP_PREFIX = "liaison:app-ddl:v2:"

let registrationCodeIdentity: string | undefined
/**
 * Identity of the code that turns a manifest into DDL: a release that changes
 * any of it re-applies every app once. Unreadable sources yield a unique value
 * (never a match), so the fallback is the full registration.
 */
function appRegistrationCodeIdentity(): string {
  if (registrationCodeIdentity) return registrationCodeIdentity
  const hash = createHash("sha256")
  const files = APP_REGISTRATION_CODE_FILES.map((f) => join(import.meta.dir, "..", "..", f))
  try {
    for (const f of files) hash.update(readFileSync(f))
    registrationCodeIdentity = hash.digest("hex")
  } catch {
    registrationCodeIdentity = `unreadable:${randomUUID()}`
  }
  return registrationCodeIdentity
}

/** The runtime roles the registration grants to; a missing one skips its grants. */
const APP_DDL_ROLES = ["liaison_admin", "liaison_definer", "liaison_rls"]

let appliedMigrations: Promise<string> | undefined
/**
 * The applied migration set (the `/healthz` migration head). Migrations create
 * the columns and policies the registration DDL asserts or builds on, so a
 * deploy that applies one re-applies every app once. Read
 * once per process: migrations run before the server starts, never inside it.
 */
function appliedMigrationsIdentity(): Promise<string> {
  appliedMigrations ??= import("~/modules/healthz").then((m) => m.computeMigrationHead())
  return appliedMigrations
}

/**
 * The database facts the registration DDL reads besides the manifest: the
 * runtime roles that exist, the app schema's shareable tables (the definer
 * role's grants follow them) and the applied migrations. Read on the
 * registration's transaction, the migrations once per process.
 */
async function appDdlDatabaseFacts(tx: PrivilegedDb, schemaName: string): Promise<string> {
  const [row] = extractRows<{ roles: string | null; shareable: string | null }>(
    await tx.execute(drizzleSql`
      SELECT
        (SELECT string_agg(rolname::text, ',' ORDER BY rolname) FROM pg_roles
          WHERE rolname = ANY(${`{${APP_DDL_ROLES.join(",")}}`}::text[])) AS roles,
        (SELECT string_agg(c.relname::text, ',' ORDER BY c.relname)
           FROM ${drizzleSql.raw(schemaRef("kernel"))}.shareable_resource_types t
           JOIN pg_class c ON c.oid = t.resource_table
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${schemaName}) AS shareable
    `),
  )
  const migrations = await appliedMigrationsIdentity()
  return `roles=${row?.roles ?? ""};shareable=${row?.shareable ?? ""};migrations=${migrations}`
}

/**
 * The stamp a registration writes on its app schema: everything the schema DDL
 * is derived from. The manifest (schema, entities, RLS mode, roles and
 * settings), the install's trust flags (they decide whether its triggers may be
 * created at all), the registration code, and the database facts
 * (`appDdlDatabaseFacts`). Each one changing makes the stamp stale.
 */
function appDdlStamp(desc: AppDescriptor, schemaName: string, databaseFacts: string): string {
  const digest = createHash("sha256")
    .update(`${appDdlManifestKey(desc, schemaName)}:${databaseFacts}`)
    .digest("hex")
  return `${APP_DDL_STAMP_PREFIX}${digest}`
}

/** `appDdlStamp` without the database facts: what this process's build and the descriptor decide. */
function appDdlManifestKey(desc: AppDescriptor, schemaName: string): string {
  const d = desc as any
  const manifestHash = computeSchemaHash({
    name: desc.name,
    version: desc.version,
    schemaName,
    schema: d.schema ?? null,
    entities: d.entities ?? null,
    rlsManagedBy: d.rlsManagedBy ?? null,
    orgSettings: d.orgSettings ?? null,
    roles: d.roles ?? null,
    memberPresetScopes: d.memberPresetScopes ?? null,
    everyMemberScopes: d.everyMemberScopes ?? null,
    trust: {
      installed: desc._installed === true,
      firstParty: desc._firstParty === true,
      publisherSigned: desc._publisherSigned === true,
    },
  })
  return `${manifestHash}:${appRegistrationCodeIdentity()}`
}

/**
 * App schemas this process found (or made) current, by `appDdlManifestKey`. The
 * registration of an org whose setup stamp matches (`skipOrgRows`: same build,
 * same app versions, set up before) writes nothing; once one registration in
 * this process saw the app's schema current, the next orgs' skip its DDL check,
 * so a burst of first touches after a deploy does not hold a privileged
 * connection per app per org. A changed descriptor (version, trust flags) is a
 * new key and is checked again.
 */
const currentAppSchemaKeys = new Set<string>()

/** Test seam: forget which app schemas this process saw current (a fresh process). */
export const AppSchemaDdlTestAccess = {
  forgetCurrentSchemas(): void {
    currentAppSchemaKeys.clear()
  },
}

/**
 * An app's event handler runs only while the app is On for the EVENT's org
 * (S19, A6): subscriptions are channel-global, so a handler registered for one
 * org also receives other orgs' events, and the gate keys on `event.orgId`.
 * Fail-closed: an unreadable state throws, so a durable delivery retries
 * instead of running or silently dropping. Events received while Off are not
 * replayed on re-enable (D24).
 */
export function gateEventOnAppState(
  appName: string,
  registeringOrgId: string,
  inner: (event: any) => Promise<void>,
): (event: any) => Promise<void> {
  return async (event: any) => {
    const eventOrgId: string = event?.orgId ?? registeringOrgId
    // An org-private app hears its own org's events only (app-org-scope.ts),
    // and none while that org is suspended or closed.
    if (!(await appVisibleToOrg(appName, eventOrgId))) {
      log.debug({ app: appName, orgId: eventOrgId }, "event skipped: another org's custom app")
      return
    }
    if ((await isOrgPrivateApp(appName)) && (await orgSuspendedOrClosed(eventOrgId))) {
      log.debug({ app: appName, orgId: eventOrgId }, "event skipped: the org is suspended")
      return
    }
    if (!(await isAppActiveForOrgAsync(eventOrgId, appName))) {
      log.debug({ app: appName, orgId: eventOrgId }, "event skipped: the app is Off for the org")
      return
    }
    await inner(event)
  }
}

/** 55P03 (lock_not_available, a lock_timeout) or 40P01 (deadlock_detected). */
function isDdlLockConflict(err: unknown): boolean {
  const code = describeDbError(err).code
  return code === "55P03" || code === "40P01"
}

/**
 * Run the registration transaction, retrying it when it lost a lock race or a
 * deadlock (`appDdlLockPolicy`). `fn` receives the lock timeout its attempt
 * runs under; 0 means it waits for its locks (a server's last attempt).
 */
async function withAppDdlLockRetry<T>(
  appName: string,
  fn: (lockTimeoutMs: number) => Promise<T>,
): Promise<T> {
  const attempts = Math.max(1, appDdlLockPolicy.maxAttempts)
  const finalAttemptWaits = process.env.LIAISON_CLI !== "1"
  let backoffMs = appDdlLockPolicy.backoffMs
  for (let attempt = 1; ; attempt++) {
    const waits = finalAttemptWaits && attempt > attempts
    try {
      return await fn(waits ? 0 : Math.max(1, Math.trunc(appDdlLockPolicy.lockTimeoutMs)))
    } catch (err) {
      if (waits || !isDdlLockConflict(err) || (!finalAttemptWaits && attempt >= attempts)) {
        throw err
      }
      appRegistrationStats.lockTimeouts++
      log.warn(
        {
          app: appName,
          attempt,
          sqlState: describeDbError(err).code,
          lockTimeoutMs: appDdlLockPolicy.lockTimeoutMs,
          backoffMs,
        },
        "App registration DDL: a table lock is busy, retrying",
      )
      await new Promise((r) => setTimeout(r, backoffMs))
      backoffMs *= 2
    }
  }
}

function quoteLiteralSql(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * Stamp an app schema with the DDL fingerprint just applied. A role that does not
 * own the schema (a per-worker test clone, a schema an operator created by hand)
 * only loses the skip, never the registration: the COMMENT runs in a nested
 * transaction, so its failure rolls back alone. A raw `SAVEPOINT` statement is
 * not enough: the driver still fails the enclosing transaction on the error.
 */
export async function stampAppSchema(
  tx: {
    transaction: <T>(
      fn: (sp: { execute: (q: SQL) => Promise<unknown> }) => Promise<T>,
    ) => Promise<T>
  },
  schemaName: string,
  ddlStamp: string,
): Promise<boolean> {
  try {
    await tx.transaction((sp) =>
      sp.execute(
        drizzleSql.raw(
          `COMMENT ON SCHEMA ${quoteIdent(schemaName)} IS ${quoteLiteralSql(ddlStamp)}`,
        ),
      ),
    )
    return true
  } catch (err) {
    log.debug({ err, schemaName }, "App schema stamp not written")
    return false
  }
}

/** The manifest's `everyMemberScopes`, as strings (contract-validated). */
function everyMemberScopesOf(desc: AppDescriptor): string[] {
  const declared = (desc as { everyMemberScopes?: unknown }).everyMemberScopes
  return Array.isArray(declared) ? declared.filter((s): s is string => typeof s === "string") : []
}

/**
 * The rows an app registration writes for ONE org: its `kernel.apps` row, the
 * org settings defaults it declares, and its manifest roles. Runs inside the
 * registration transaction, after the schema DDL (or in place of it when the
 * schema is already current, see `appSchemaDdlReuse`). Takes the org's
 * `org-setup` lock first (setup-stamp.ts; lock order `app-ddl` → `org-setup`).
 */
async function writeOrgAppRows(
  tx: PrivilegedDb,
  desc: AppDescriptor,
  orgId: string,
): Promise<void> {
  await tx.execute(orgSetupLockSql(orgId))
  appRegistrationStats.orgRowWrites++
  // Record in kernel.apps — inside the same DDL transaction for atomicity.
  // Uses INSERT ... ON CONFLICT to handle concurrent registration safely.
  const schemaHash = computeSchemaHash(desc.schema)
  const appsTable = drizzleSql.raw(`${schemaRef("kernel")}.apps`)
  // `xmax = 0` is true only for a freshly inserted row, so `firstInstall`
  // tells the app's first registration in this org from every later boot.
  // The manifest's every-member scopes, rewritten on every registration so a
  // manifest change reaches the org at the next boot (loadEffectivePermissions
  // reads them).
  const everyMemberScopes = everyMemberScopesOf(desc)
  const everyMemberArray = drizzleSql`ARRAY[${drizzleSql.join(
    everyMemberScopes.map((s) => drizzleSql`${s}`),
    drizzleSql`, `,
  )}]::text[]`
  const instanceInstalled = isManagedEdition()
    ? extractRows(
        await tx.execute(drizzleSql`
          SELECT 1 FROM ${drizzleSql.raw(`${schemaRef("kernel")}.apps_installed`)}
           WHERE name = ${desc.name} AND org_id IS NULL LIMIT 1`),
      ).length > 0
    : false
  const managed = isManagedEdition()
  const firstStatus = firstAppStatus({
    managed,
    // Managed, the setting alone names the operator: this reads no database.
    isOperatorOrg: managed && orgId === (await resolveOperatorOrgId()),
    instanceInstalled,
  })
  const appsUpsert = await tx.execute(drizzleSql`
    INSERT INTO ${appsTable} (id, org_id, name, version, status, schema_hash, every_member_scopes, created_at, updated_at)
    VALUES (gen_random_uuid(), ${orgId}, ${desc.name}, ${desc.version}, ${firstStatus}, ${schemaHash}, ${everyMemberArray}, now(), now())
    ON CONFLICT (org_id, name) DO UPDATE
      SET version = EXCLUDED.version,
          -- The workspace's On/Off/removed state survives every re-register and
          -- upgrade (A24-1); only a failed registration recovers to active.
          status = CASE WHEN ${appsTable}.status = 'error' THEN 'active' ELSE ${appsTable}.status END,
          problem_code = NULL, problem_message = NULL,
          schema_hash = EXCLUDED.schema_hash,
          every_member_scopes = EXCLUDED.every_member_scopes, updated_at = now()
    RETURNING (xmax = 0) AS inserted
  `)
  const firstInstall = extractRows<{ inserted: boolean }>(appsUpsert)[0]?.inserted === true

  // Auto-seed org settings defaults if declared.
  const orgDefaults = (desc as any).orgSettings?.defaults
  if (orgDefaults && typeof orgDefaults === "object") {
    const json = JSON.stringify(orgDefaults)
    const orgsTable = drizzleSql.raw(`${schemaRef("kernel")}.organizations`)
    const nsPath = `{${desc.name}}`
    await tx.execute(drizzleSql`
          UPDATE ${orgsTable}
          SET settings = jsonb_set(settings, ${nsPath}, ${json}::jsonb, true)
          WHERE id = ${orgId} AND NOT (settings ? ${desc.name})
        `)
  }

  // Seed manifest roles.
  if ((desc as any).roles) {
    const manifestRoles = (desc as any).roles as Record<
      string,
      { description?: string; extends?: string; scopes: string[] }
    >
    await seedManifestRoles(tx as any, orgId, desc.name, manifestRoles)
    // Keep the auto-maintained "Full Member" role in sync with this app's
    // non-admin scopes so full members reach newly installed apps without a
    // manual role edit.
    await extendFullMemberRole(tx as any, orgId, manifestRoles)
    // One-shot: the kernel `member` preset gains the app's declared
    // member-preset scopes on the app's first install in this org only.
    if (firstInstall) {
      await grantMemberPresetScopes(tx as any, orgId, (desc as any).memberPresetScopes)
    }
  }
}

/**
 * The in-memory facts a registration records for each declared entity: its
 * dimension definitions and its timeline declarations. Org-scoped and free of
 * DDL, so a registration that reuses an already-applied schema records them
 * exactly as the full one does.
 */
function registerEntityDeclarations(
  desc: AppDescriptor,
  orgId: string,
  entityName: string,
  entityDef: any,
): void {
  // Store dimension definitions when present. Multiple entities can
  // declare the same dimension key (eg. tickets:team is canonical on
  // the tickets entity but `messages` re-declares it with inheritFrom
  // so RLS knows how to derive the value). Merge so the catalog-facing
  // metadata (values, label, description) from the canonical entry is
  // preserved when an inheriting entry comes in later.
  if (entityDef.dimensions) {
    for (const [dimKey, dimDef] of Object.entries(entityDef.dimensions as Record<string, any>)) {
      const existing = dimensionDefRegistry.get([orgId, desc.name, dimKey])
      const merged = existing ? { ...dimDef, ...existing } : dimDef
      dimensionDefRegistry.set([orgId, desc.name, dimKey], merged)
    }
  }

  // Register timeline declarations under both the schema/entity name (plural)
  // and the entities[].handlePrefix (singular) so emitters can use either form.
  if (entityDef.timeline) {
    const timelineDecl = {
      app: desc.name,
      entity: entityName,
      fields: entityDef.timeline,
    }
    timelineDeclarations.set([orgId, desc.name, entityName], timelineDecl)
    const entityDecls = (desc.entities as Record<string, any> | undefined) ?? {}
    for (const [canonicalKey, entityDecl] of Object.entries(entityDecls)) {
      if (entityDecl?.tableName !== entityName && canonicalKey !== entityName) continue
      if (canonicalKey !== entityName) {
        timelineDeclarations.set([orgId, desc.name, canonicalKey], timelineDecl)
      }
      const handlePrefix = entityDecl?.handlePrefix
      if (typeof handlePrefix === "string" && handlePrefix !== entityName) {
        timelineDeclarations.set([orgId, desc.name, handlePrefix], timelineDecl)
      }
    }
  }
}

/**
 * Table privileges the request role (liaison_rls) holds on an app schema: the
 * kernel baseline (0000_initial.sql), never ALL. TRUNCATE and TRIGGER ignore
 * row-level security, FORCE included, so on the request connection they would
 * reach every org's rows. The owner role keeps ALL.
 */
const REQUEST_ROLE_TABLE_PRIVILEGES = "SELECT, INSERT, UPDATE, DELETE, REFERENCES"

function tablePrivilegesFor(role: "liaison_rls" | "liaison_admin"): string {
  return role === "liaison_rls" ? REQUEST_ROLE_TABLE_PRIVILEGES : "ALL"
}

/**
 * What liaison_definer needs on each shareable table in `schemaName` (a row of
 * kernel.shareable_resource_types): USAGE on the schema, SELECT, and UPDATE of
 * the two search-ACL columns kernel.recompute_search_acl writes. Nothing else.
 */
async function grantDefinerOnShareableTables(
  tx: { execute: (q: SQL) => Promise<unknown> },
  schemaName: string,
): Promise<void> {
  const tables = extractRows<{ table: string }>(
    await tx.execute(drizzleSql`
      SELECT c.relname::text AS table
        FROM ${drizzleSql.raw(schemaRef("kernel"))}.shareable_resource_types t
        JOIN pg_class c ON c.oid = t.resource_table
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${schemaName}`),
  )
  if (tables.length === 0) return
  const definer = extractRows<{ n: number }>(
    await tx.execute(
      drizzleSql`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'liaison_definer'`,
    ),
  )[0]?.n
  if (!definer) return
  await tx.execute(
    drizzleSql.raw(`GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO liaison_definer`),
  )
  for (const { table } of tables) {
    await tx.execute(
      drizzleSql.raw(
        `GRANT SELECT, UPDATE (acl_user_ids, acl_role_ids) ON ${quoteIdent(schemaName)}.${quoteIdent(table)} TO liaison_definer`,
      ),
    )
  }
}

/**
 * What a version switch keeps of the old registration until the new one is in
 * place: every app-keyed registry's entries, its slot contributions, declared
 * emits, external-search handler, event subscriptions and registration record.
 * On success `pruneOldVersion` removes what only the old version had; on failure
 * `restoreOldVersion` puts it all back, so the running version never has a gap.
 */
interface OldVersionSnapshot {
  journal: RegistryJournal
  entries: Map<string, unknown>[]
  contributions: Set<unknown>
  emits: Set<string> | undefined
  searchHandler: object | undefined
  subscriptions: Array<() => Promise<void> | void> | undefined
  version: string | undefined
}

async function snapshotOldVersion(orgId: string, appName: string): Promise<OldVersionSnapshot> {
  const { externalSearchHandlerEntry } = await import("~/modules/search/external-handlers")
  const contributions = new Set<unknown>()
  for (const [key, entries] of contributionRegistry.entriesOf(orgId)) {
    if (key[0] !== orgId) continue
    for (const e of entries as Array<{ app: string }>) if (e.app === appName) contributions.add(e)
  }
  return {
    journal: openRegistryJournal(),
    entries: APP_KEYED_REGISTRIES.map(
      (registry) => registry.snapshotUnder([orgId, appName]) as Map<string, unknown>,
    ),
    contributions,
    emits: declaredEmits.get(`${orgId}:${appName}`),
    searchHandler: externalSearchHandlerEntry(orgId, appName),
    subscriptions: eventSubscriptionDisposers.get([orgId, appName]) as
      | Array<() => Promise<void> | void>
      | undefined,
    version: registeredAppVersions.get(`${orgId}:${appName}`),
  }
}

async function disposeAll(
  orgId: string,
  appName: string,
  disposers: Array<() => Promise<void> | void> | undefined,
): Promise<void> {
  for (const dispose of disposers ?? []) {
    try {
      await dispose()
    } catch (err) {
      log.warn({ err, app: appName, orgId }, "Event subscription disposer failed")
    }
  }
}

/** Remove what only the old version registered, once the new version is registered over it. */
async function pruneOldVersion(
  orgId: string,
  appName: string,
  snap: OldVersionSnapshot,
): Promise<void> {
  closeRegistryJournal(snap.journal)
  APP_KEYED_REGISTRIES.forEach((registry, i) => {
    ;(registry.pruneUnwritten as (s: Map<string, unknown>, j: RegistryJournal) => void)(
      snap.entries[i] ?? new Map(),
      snap.journal,
    )
  })
  for (const [key, entries] of contributionRegistry.entriesOf(orgId)) {
    if (key[0] !== orgId) continue
    const remaining = entries.filter((e: unknown) => !snap.contributions.has(e))
    if (remaining.length === entries.length) continue
    if (remaining.length === 0) contributionRegistry.delete(key)
    else contributionRegistry.set(key, remaining)
  }
  if (snap.emits && declaredEmits.get(`${orgId}:${appName}`) === snap.emits) {
    deleteDeclaredEmits(orgId, appName)
  }
  const { externalSearchHandlerEntry, unregisterExternalSearchHandler } = await import(
    "~/modules/search/external-handlers"
  )
  if (snap.searchHandler && externalSearchHandlerEntry(orgId, appName) === snap.searchHandler) {
    unregisterExternalSearchHandler(orgId, appName)
  }
  // The old version's subscriptions go only now that the new version's are live.
  if (eventSubscriptionDisposers.get([orgId, appName]) === snap.subscriptions) {
    eventSubscriptionDisposers.delete([orgId, appName])
  }
  await disposeAll(orgId, appName, snap.subscriptions)
}

/** Put the old version's registration back exactly, after the new version failed to register. */
async function restoreOldVersion(
  orgId: string,
  appName: string,
  snap: OldVersionSnapshot,
): Promise<void> {
  closeRegistryJournal(snap.journal)
  APP_KEYED_REGISTRIES.forEach((registry, i) => {
    ;(registry.restoreUnder as (p: string[], s: Map<string, unknown>) => void)(
      [orgId, appName],
      snap.entries[i] ?? new Map(),
    )
  })
  for (const [key, entries] of contributionRegistry.entriesOf(orgId)) {
    if (key[0] !== orgId) continue
    const kept = entries.filter(
      (e: { app: string }) => e.app !== appName || snap.contributions.has(e),
    )
    if (kept.length === entries.length) continue
    if (kept.length === 0) contributionRegistry.delete(key)
    else contributionRegistry.set(key, kept)
  }
  if (snap.emits) setDeclaredEmits(orgId, appName, snap.emits)
  else deleteDeclaredEmits(orgId, appName)
  const { restoreExternalSearchHandlerEntry } = await import("~/modules/search/external-handlers")
  restoreExternalSearchHandlerEntry(orgId, appName, snap.searchHandler)
  const current = eventSubscriptionDisposers.get([orgId, appName])
  if (current !== snap.subscriptions) {
    await disposeAll(orgId, appName, current as Array<() => Promise<void> | void> | undefined)
  }
  if (snap.subscriptions)
    eventSubscriptionDisposers.set([orgId, appName], snap.subscriptions as never)
  else eventSubscriptionDisposers.delete([orgId, appName])
  registeredApps.add(`${orgId}:${appName}`)
  if (snap.version) registeredAppVersions.set(`${orgId}:${appName}`, snap.version)
  invalidateScopeCatalog(orgId)
  invalidateDimensionCatalog(orgId)
}

/**
 * Register one app in one org. Returns false when it was already registered at
 * this version with its schema intact (nothing done).
 *
 * `swap` (activation.ts) switches a registered app to another version without a
 * gap: the new version registers over the old one, then only the old version's
 * leftovers are removed, so a reader finds the old tool or the new one, never
 * none (A15). Without it, a version change tears the old registration down first.
 */
async function registerSingleApp(
  desc: AppDescriptor,
  orgId: string,
  opts: {
    swap?: boolean
    skipOrgRows?: boolean
    serializeDdl?: RegisterAppsOptions["serializeDdl"]
  } = {},
): Promise<boolean> {
  // The lowest registration step refuses another org's custom app too, whatever
  // path reached it (boot, first touch, activation, reload): app-org-scope.ts.
  if (!(await appVisibleToOrg(desc.name, orgId))) return false
  const registrationKey = `${orgId}:${desc.name}`
  let oldVersion: OldVersionSnapshot | null = null
  if (opts.swap) {
    const inFlight = appRegistrationPromises.get(registrationKey)
    if (inFlight) await inFlight.catch(() => undefined)
    if (registeredApps.has(registrationKey)) {
      oldVersion = await snapshotOldVersion(orgId, desc.name)
      registeredApps.delete(registrationKey)
      registeredAppVersions.delete(registrationKey)
    }
  } else if (registeredApps.has(registrationKey)) {
    const registeredVersion = registeredAppVersions.get(registrationKey)
    if (registeredVersion === desc.version) {
      // The in-memory registration says nothing about the DATABASE. A live
      // table can lose columns (or vanish) under a registration that still
      // looks current — a restore, a fixture that took the schema over, an
      // operator drop — and the version-keyed fast path would then hand every
      // later caller a shape the manifest does not describe, with the ALTER
      // TABLE reconcile in the registration body never reached. Probe first,
      // and only skip when the live schema still carries what is declared.
      let drift: string[] = []
      try {
        drift = await findDriftedSchemaObjects(desc, orgId)
      } catch (err) {
        // A failed probe must never block a healthy app: keep the skip.
        log.warn({ err, app: desc.name, orgId }, "App schema drift probe failed, skipping")
        return false
      }
      if (drift.length === 0) {
        log.debug({ app: desc.name, orgId }, "App already registered, skipping")
        return false
      }
      log.warn(
        { app: desc.name, orgId, missing: drift.slice(0, 20), missingCount: drift.length },
        "Registered app schema drifted from its manifest, re-registering to reconcile",
      )
    } else {
      // Version changed (catalog upgrade): the old bundle dir is gone from disk,
      // so keeping the stale registration would ENOENT every tool call until a
      // restart. Tear down the old in-memory registration and fall through to a
      // fresh register (registration resumes any routines the teardown paused).
      log.info(
        { app: desc.name, orgId, from: registeredVersion, to: desc.version },
        "App version changed — re-registering",
      )
    }
    await teardownAppRegistrations(orgId, desc.name)
  }

  const inFlight = appRegistrationPromises.get(registrationKey)
  if (inFlight) {
    await inFlight
    return false
  }

  const registrationPromise = (async () => {
    const schemaName = validateIdentifier(schemaRef(`app_${desc.name.replace(/-/g, "_")}`))
    let ranSchemaDdl = false

    // Wrap all DDL in a transaction — PostgreSQL DDL is transactional, so a crash
    // mid-registration rolls back everything instead of leaving tables without RLS.
    // Routed through withSchemaAdmin so the audit reason ("register-app-schema:
    // <name>") is logged. The original Vuln 5 fix also intended to switch to
    // a dedicated role here; see withSchemaAdmin's doc for why the role
    // boundary is deferred.
    // An app schema already current at its DDL stamp gets only this org's rows
    // (`appSchemaDdlReuse`), in the server and the CLI alike: a redeploy with no
    // app change, and every org after the first one of an upgrade, takes no DDL
    // lock on the tables the other orgs' requests and jobs are using.
    const manifestKey = appDdlManifestKey(desc, schemaName)
    if (opts.skipOrgRows && appSchemaDdlReuse.enabled && currentAppSchemaKeys.has(manifestKey)) {
      appRegistrationStats.ddlCheckSkipped++
      for (const [entityName, entityDef] of sortEntitiesByFk(
        (desc.schema ?? {}) as Record<string, any>,
      )) {
        registerEntityDeclarations(desc, orgId, entityName, entityDef)
      }
    } else {
      // `reuseOnly`: reuse the schema when it is current, else change nothing
      // and answer false (the caller then runs the full transaction).
      const schemaTransaction = (reuseOnly: boolean): Promise<boolean> =>
        withAppDdlLockRetry(
          desc.name,
          (lockTimeoutMs) =>
            withSchemaAdmin(orgId, `register-app-schema:${desc.name}`, async (tx) => {
              const ddlStamp = appDdlStamp(
                desc,
                schemaName,
                await appDdlDatabaseFacts(tx, schemaName),
              )
              const reuseCurrentSchema = async (): Promise<boolean> => {
                if (!appSchemaDdlReuse.enabled) return false
                if (!(await isAppSchemaDdlCurrent(tx, desc, orgId, schemaName, ddlStamp)))
                  return false
                appRegistrationStats.ddlReused++
                for (const [entityName, entityDef] of sortEntitiesByFk(
                  (desc.schema ?? {}) as Record<string, any>,
                )) {
                  registerEntityDeclarations(desc, orgId, entityName, entityDef)
                }
                if (!opts.skipOrgRows) await writeOrgAppRows(tx, desc, orgId)
                currentAppSchemaKeys.add(manifestKey)
                return true
              }
              if (await reuseCurrentSchema()) return true
              if (reuseOnly) return false
              // Serialize concurrent multi-org DDL for the same app schema, then look
              // again: the org that held the lock may just have brought it current.
              const lockId = fnv1a32(`app-ddl:${schemaName}`)
              await tx.execute(drizzleSql`SELECT pg_advisory_xact_lock(${lockId})`)
              if (await reuseCurrentSchema()) return true
              appRegistrationStats.ddlTransactions++
              ranSchemaDdl = true
              // Never sit in a table's lock queue behind a long read: every later
              // reader would queue behind this DDL. Time out and retry instead
              // (`withAppDdlLockRetry`); only a server's last attempt waits.
              if (lockTimeoutMs > 0) {
                await tx.execute(drizzleSql.raw(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`))
              }
              // Create schema if not exists
              await tx.execute(
                drizzleSql.raw(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`),
              )

              // Grant schema access to liaison_rls and liaison_admin roles.
              // USAGE is granted now; table-level grants are applied after entity creation (see below).
              // The request role gets the kernel baseline (REQUEST_ROLE_TABLE_PRIVILEGES), never ALL:
              // TRUNCATE and TRIGGER ignore RLS. REVOKE first so a default an older registration
              // set to ALL is narrowed too.
              try {
                for (const role of ["liaison_rls", "liaison_admin"] as const) {
                  await tx.execute(
                    drizzleSql.raw(`GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO ${role}`),
                  )
                  if (role === "liaison_rls") {
                    await tx.execute(
                      drizzleSql.raw(
                        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schemaName)} REVOKE ALL ON TABLES FROM ${role}`,
                      ),
                    )
                  }
                  await tx.execute(
                    drizzleSql.raw(
                      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schemaName)} GRANT ${tablePrivilegesFor(role)} ON TABLES TO ${role}`,
                    ),
                  )
                  await tx.execute(
                    drizzleSql.raw(
                      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(schemaName)} GRANT ALL ON SEQUENCES TO ${role}`,
                    ),
                  )
                }
              } catch (err: any) {
                const code = err.code ?? err.cause?.code
                if (code === "42704") {
                  log.debug(
                    { schemaName },
                    "liaison_rls/liaison_admin role not found, skipping grants",
                  )
                } else {
                  log.warn({ err, schemaName }, "Failed to grant schema access")
                }
              }

              // Reachability guard: warn if any governed table's effective RLS
              // scope-entity (its `rlsScope` alias, else the table name) is not matched
              // by any declared grantable scope. Such a table is unreachable for every
              // grantable role → least-privilege users fail on it (the invoicing
              // document_lines/issuer_profiles bug). Non-fatal so 3rd-party installs are
              // not blocked, but loud so the misconfig surfaces.
              //
              // A table whose access the migrations own (app `rlsManagedBy:
              // "migration"`, or table `rlsGovernedByMigration`) is judged on the
              // database instead: it is unreachable only when no migration policy on
              // it can grant anything (every one is a `USING (false)` deny-default).
              if (desc.schema) {
                // Per-app scope aliases widen the RLS context of every handler call
                // (withAppDimensionAliases), so they count toward reachability.
                const grantable = grantableScopesWithAppAliases(
                  desc.name,
                  declaredGrantableScopes(desc as any),
                )
                const rlsOpts = { rlsManagedBy: (desc as { rlsManagedBy?: unknown }).rlsManagedBy }
                const unreachable = tablesUnreachableByGrantableScopes(
                  desc.name,
                  desc.schema as Record<string, { rlsScope?: unknown }>,
                  grantable,
                  rlsOpts,
                )
                const migrationGoverned = migrationGovernedTables(
                  desc.schema as Record<string, { rlsGovernedByMigration?: unknown }>,
                  rlsOpts,
                )
                if (migrationGoverned.length > 0) {
                  // In a nested transaction (a savepoint the driver knows about): a
                  // diagnostic must never abort the registration.
                  try {
                    const granted = new Set(
                      extractRows<{ tablename: string }>(
                        await tx.transaction((sp) =>
                          sp.execute(drizzleSql`
              SELECT DISTINCT tablename FROM pg_policies
              WHERE schemaname = ${schemaName}
                AND tablename = ANY(${`{${migrationGoverned.join(",")}}`}::text[])
                AND policyname !~ ('^' || tablename || '_rls_(select|insert|update|delete)$')
                AND NOT (COALESCE(qual, 'false') = 'false' AND COALESCE(with_check, 'false') = 'false')
            `),
                        ),
                      ).map((r) => r.tablename),
                    )
                    for (const table of migrationGoverned) {
                      if (!granted.has(table)) unreachable.push(table)
                    }
                  } catch (err) {
                    log.debug({ err, app: desc.name }, "Migration policy probe failed; skipped")
                  }
                }
                if (unreachable.length > 0) {
                  log.warn(
                    { app: desc.name, tables: unreachable, grantableScopes: grantable },
                    "App declares governed tables no grantable scope can reach; least-privilege roles will fail on them. Declare a per-table `rlsScope` alias or add a grantable scope, or, for a table whose access a migration policy grants, mark it `rlsGovernedByMigration` and make sure that policy exists.",
                  )
                }
              }

              // Process entity schemas — topologically sort by intra-app FK references so
              // tables that are referenced are created before tables that reference them.
              if (desc.schema) {
                const orderedEntities = sortEntitiesByFk(desc.schema as Record<string, any>)
                for (const [entityName, entityDef] of orderedEntities) {
                  validateIdentifier(entityName)
                  // If the entity declares a handlePrefix, ensure the per-entity sequence exists
                  // before the table is created (the table's handle column is NOT NULL).
                  const entityHasHandlePrefix = !!desc.entities?.[entityName]?.handlePrefix
                  if (entityHasHandlePrefix) {
                    await tx.execute(drizzleSql.raw(generateSequenceDdl(schemaName, entityName)))
                  }
                  // Generate DDL from field declarations (with ALTER TABLE support for new columns)
                  if (entityDef.fields) {
                    // Check if table already exists before deciding create vs alter
                    const [tableCheck] = extractRows<{ exists: boolean }>(
                      await tx.execute(drizzleSql`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = ${schemaName} AND table_name = ${entityName}
        ) AS "exists"
      `),
                    )
                    const tableExists = tableCheck.exists

                    if (tableExists) {
                      // Fetch full column metadata for drift detection
                      const cols = extractRows<{
                        column_name: string
                        data_type: string
                        is_nullable: string
                      }>(
                        await tx.execute(drizzleSql`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = ${schemaName} AND table_name = ${entityName}
        `),
                      )
                      const existingColMap = new Map<string, { type: string; nullable: string }>(
                        cols.map((c) => [
                          c.column_name,
                          { type: c.data_type, nullable: c.is_nullable },
                        ]),
                      )

                      // Detect type and nullability mismatches on existing columns
                      for (const [fieldName, fieldDef] of Object.entries(
                        entityDef.fields as Record<string, any>,
                      )) {
                        const colName = fieldName.replace(/([A-Z])/g, "_$1").toLowerCase()
                        const existing = existingColMap.get(colName)
                        if (existing) {
                          const expectedPgType = mapFieldTypeToPgDataType(fieldDef)
                          if (expectedPgType && existing.type !== expectedPgType) {
                            log.warn(
                              {
                                app: desc.name,
                                entity: entityName,
                                column: colName,
                                existingType: existing.type,
                                expectedType: expectedPgType,
                              },
                              "Schema drift detected: column type mismatch",
                            )
                          }
                          const expectedNullable = isFieldNullable(fieldDef) ? "YES" : "NO"
                          // A column an earlier version added nullable (the ADD COLUMN
                          // path used to drop NOT NULL) is tightened to the manifest:
                          // backfill NULLs with the declared default, then SET NOT NULL.
                          // Under a savepoint so a failure (the default violating a
                          // CHECK, a lock timeout) only leaves the drift warning below
                          // and never aborts the registration.
                          const tighten =
                            existing.nullable === "YES" && expectedNullable === "NO"
                              ? generateNotNullTightenDdl(
                                  schemaName,
                                  entityName,
                                  fieldName,
                                  fieldDef,
                                )
                              : null
                          if (tighten) {
                            try {
                              // A nested transaction: a failed tighten rolls back alone.
                              await tx.transaction(async (sp) => {
                                for (const stmt of tighten) await sp.execute(drizzleSql.raw(stmt))
                              })
                              existing.nullable = "NO"
                              log.info(
                                { app: desc.name, entity: entityName, column: colName },
                                "Column tightened to NOT NULL to match the manifest",
                              )
                            } catch (err) {
                              log.warn(
                                { err, app: desc.name, entity: entityName, column: colName },
                                "Schema drift: NOT NULL tighten failed",
                              )
                            }
                          }
                          if (existing.nullable !== expectedNullable) {
                            log.warn(
                              {
                                app: desc.name,
                                entity: entityName,
                                column: colName,
                                existingNullable: existing.nullable,
                                expectedNullable,
                              },
                              "Schema drift detected: column nullability mismatch",
                            )
                          }
                        }
                      }

                      // Detect removed columns (in DB but not in descriptor)
                      const declaredCols = new Set(
                        Object.keys(entityDef.fields as Record<string, any>).map((f) =>
                          f.replace(/([A-Z])/g, "_$1").toLowerCase(),
                        ),
                      )
                      const systemCols = new Set(["id", "org_id", "created_at", "updated_at"])
                      // `handle` is the system column of an entity declaring a
                      // `handlePrefix` (minted from a sequence, e.g. tickets'
                      // `ticket-<n>`); the entity names its table in `tableName`.
                      const handleEntity = Object.entries(
                        (desc.entities ?? {}) as Record<
                          string,
                          { tableName?: string; handlePrefix?: string }
                        >,
                      ).some(([key, e]) => !!e?.handlePrefix && (e.tableName ?? key) === entityName)
                      if (handleEntity) systemCols.add("handle")
                      // Columns a migration owns on purpose (sharing model columns RLS
                      // reads, generated columns) and the manifest deliberately does
                      // not declare: declaring them would also open them to app writes.
                      const migrationOwned = (entityDef as { migrationOwnedColumns?: unknown })
                        .migrationOwnedColumns
                      if (Array.isArray(migrationOwned)) {
                        for (const c of migrationOwned) {
                          if (typeof c === "string")
                            systemCols.add(c.replace(/([A-Z])/g, "_$1").toLowerCase())
                        }
                      }
                      for (const [colName] of existingColMap) {
                        if (!declaredCols.has(colName) && !systemCols.has(colName)) {
                          log.warn(
                            { app: desc.name, entity: entityName, column: colName },
                            "Schema drift detected: column exists in DB but not in descriptor",
                          )
                        }
                      }

                      // Reconcile enum CHECK constraints on EXISTING columns — a new app
                      // version that widens a field's enum (e.g. invoicing 0.5.0 adding
                      // 'credit_note' to documents.type) must recreate the stale
                      // `<table>_<col>_check` or every insert with the new value fails.
                      // Narrowing that existing rows violate throws — logged as drift,
                      // never fatal to registration.
                      for (const [fieldName, fieldDef] of Object.entries(
                        entityDef.fields as Record<string, any>,
                      )) {
                        if (typeof fieldDef !== "object" || !Array.isArray(fieldDef.enum)) continue
                        const colName = fieldName.replace(/([A-Z])/g, "_$1").toLowerCase()
                        // New column: both CREATE TABLE and the ALTER below emit its
                        // inline CHECK, under the name pg derives (`<table>_<col>_check`)
                        // — which is the name this reconciler looks for on later widenings.
                        if (!existingColMap.has(colName)) continue
                        const conName = `${entityName}_${colName}_check`
                        const [con] = extractRows<{ def: string }>(
                          await tx.execute(drizzleSql`
                SELECT pg_get_constraintdef(c.oid) AS def
                FROM pg_constraint c
                JOIN pg_class t ON t.oid = c.conrelid
                JOIN pg_namespace n ON n.oid = t.relnamespace
                WHERE n.nspname = ${schemaName} AND t.relname = ${entityName}
                  AND c.conname = ${conName} AND c.contype = 'c'
              `),
                        )
                        if (!con || enumCheckMatches(con.def, fieldDef.enum)) continue
                        try {
                          for (const stmt of generateEnumCheckReconcileDdl(
                            schemaName,
                            entityName,
                            colName,
                            fieldDef.enum,
                          )) {
                            await tx.execute(drizzleSql.raw(stmt))
                          }
                          log.info(
                            {
                              app: desc.name,
                              entity: entityName,
                              column: colName,
                              values: fieldDef.enum,
                            },
                            "Enum CHECK constraint reconciled to manifest",
                          )
                        } catch (err) {
                          log.warn(
                            { err, app: desc.name, entity: entityName, column: colName },
                            "Schema drift: enum CHECK reconcile failed (existing rows may violate the narrowed enum)",
                          )
                        }
                      }

                      // Add missing columns (existing additive behavior)
                      const addedFields = Object.fromEntries(
                        Object.entries(entityDef.fields as Record<string, any>).filter(
                          ([fieldName]) => {
                            const colName = fieldName.replace(/([A-Z])/g, "_$1").toLowerCase()
                            return !existingColMap.has(colName)
                          },
                        ),
                      )
                      const alterDdl = generateAlterTableDdl(
                        schemaName,
                        entityName,
                        addedFields,
                        entityDef.constraints,
                        entityDef.indexes,
                      )
                      if (alterDdl) {
                        for (const stmt of alterDdl.split(";\n").filter((s: string) => s.trim())) {
                          await tx.execute(drizzleSql.raw(stmt))
                        }
                      }

                      // Table-level UNIQUEs: CREATE TABLE emits them inline and the ALTER
                      // above does not, so a table created before the manifest declared one
                      // (or by hand) lacks it, and an ON CONFLICT on those columns fails on
                      // every write. Added when no non-partial unique index covers the same
                      // column set, under a savepoint: rows that already violate it leave a
                      // drift warning, never a failed registration.
                      //
                      // A unique index on a SUBSET of those columns covers it too: it already
                      // makes the wider tuple unique. Adding the wider one anyway gives the
                      // table a second unique index that the upsert's ON CONFLICT (on the
                      // narrow key) does not arbitrate, so two concurrent upserts of the same
                      // new row race on it and one fails with a unique violation.
                      for (const cols of declaredTableUniqueColumns(entityDef.constraints)) {
                        const [covered] = extractRows<{ ok: number }>(
                          await tx.execute(drizzleSql`
                SELECT 1 AS ok
                FROM pg_index i
                JOIN pg_class t ON t.oid = i.indrelid
                JOIN pg_namespace n ON n.oid = t.relnamespace
                WHERE n.nspname = ${schemaName} AND t.relname = ${entityName}
                  AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
                  AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
                         FROM unnest(i.indkey) AS k(attnum)
                         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum)
                    <@ ARRAY[${drizzleSql.join(
                      cols.map((c) => drizzleSql`${c}`),
                      drizzleSql`, `,
                    )}]::text[]
                LIMIT 1
              `),
                        )
                        if (covered) continue
                        try {
                          await tx.transaction(async (sp) => {
                            await sp.execute(
                              drizzleSql.raw(
                                generateTableUniqueAddDdl(schemaName, entityName, cols),
                              ),
                            )
                          })
                          log.info(
                            { app: desc.name, entity: entityName, columns: cols },
                            "Missing table UNIQUE added to match the manifest",
                          )
                        } catch (err) {
                          log.warn(
                            { err, app: desc.name, entity: entityName, columns: cols },
                            "Schema drift: table UNIQUE missing and could not be added",
                          )
                        }
                      }

                      // Reconcile runtime-owned partial-unique indexes. A new app version
                      // that CHANGES a partial unique (e.g. boxtal 0.2.0 widening the
                      // shipment uniqueness key from (document_ref) to (document_ref, kind)
                      // so an invoice can carry one outbound leg AND one return leg) moves
                      // the column list, hence the deterministic `uniq_…` name: the ALTER
                      // path above creates the NEW index, but the stale predecessor would
                      // keep enforcing the OLD rule forever. The `uniq_<schema>_<table>_…`
                      // prefix is minted only by generateTableDdl/generateAlterTableDdl,
                      // so any live index carrying it that the manifest no longer declares
                      // is drift from a prior version — drop it. (A WHERE-only change
                      // keeps the same name and is NOT reconciled here.)
                      const declaredUniq = new Set(
                        declaredPartialUniqueIndexNames(
                          schemaName,
                          entityName,
                          entityDef.constraints,
                        ),
                      )
                      const uniqPrefix = `uniq_${schemaName}_${entityName}_`
                      const likePattern = `${uniqPrefix.replace(/[\\_%]/g, (ch) => `\\${ch}`)}%`
                      const liveUniqIdx = extractRows<{ indexname: string }>(
                        await tx.execute(drizzleSql`
              SELECT indexname FROM pg_indexes
              WHERE schemaname = ${schemaName} AND tablename = ${entityName}
                AND indexname LIKE ${likePattern}
            `),
                      )
                      for (const { indexname } of liveUniqIdx) {
                        if (declaredUniq.has(indexname)) continue
                        await tx.execute(
                          drizzleSql.raw(generateDropIndexDdl(schemaName, indexname)),
                        )
                        log.info(
                          { app: desc.name, entity: entityName, index: indexname },
                          "Stale partial-unique index dropped (no longer declared by the manifest)",
                        )
                      }
                    } else {
                      const ddl = generateTableDdl(
                        schemaName,
                        entityName,
                        entityDef.fields,
                        entityDef.constraints,
                        entityDef.indexes,
                        entityHasHandlePrefix ? { handle: true } : undefined,
                      )
                      for (const stmt of ddl.split(";\n").filter((s: string) => s.trim())) {
                        await tx.execute(drizzleSql.raw(stmt))
                      }
                    }
                  }

                  if (entityDef.triggers) {
                    // Trigger bodies are SQL that runs in every writer's RLS transaction.
                    // An installed app may ship them only when the platform or the
                    // operator vouched for the package, and then only after review.
                    const d = desc as {
                      _installed?: boolean
                      _firstParty?: boolean
                      _publisherSigned?: boolean
                    }
                    if (d._installed === true && d._firstParty !== true) {
                      if (d._publisherSigned !== true) {
                        throw new Error(
                          `App '${desc.name}' declares database triggers but is neither first-party nor signed by a trusted publisher: refusing to create them`,
                        )
                      }
                      for (const [trgName, trgDef] of Object.entries(
                        entityDef.triggers as Record<string, { body?: string }>,
                      )) {
                        reviewTriggerBody(
                          String(trgDef?.body ?? ""),
                          schemaName,
                          `${entityName}.${trgName}`,
                        )
                      }
                    }
                    for (const [trgName, trgDef] of Object.entries(
                      entityDef.triggers as Record<string, any>,
                    )) {
                      const ddl = generateTriggerDdl(schemaName, entityName, trgName, trgDef)
                      for (const stmt of ddl.split(";\n").filter((s: string) => s.trim())) {
                        await tx.execute(drizzleSql.raw(stmt))
                      }
                    }
                  }

                  // Kernel immutability (legal records): write-once rows, no delete within the
                  // retention period. Dropped again if a later version stops declaring it.
                  {
                    const ddl = entityDef.immutable
                      ? generateImmutableTriggerDdl(schemaName, entityName, entityDef.immutable)
                      : generateDropImmutableTriggerDdl(schemaName, entityName)
                    for (const stmt of ddl.split(";\n").filter((s: string) => s.trim())) {
                      await tx.execute(drizzleSql.raw(stmt))
                    }
                  }

                  // Generate RLS policies (always — org isolation is mandatory even without dimensions),
                  // UNLESS the manifest declares its RLS as migration-managed. In that case the migration
                  // owns the policy definitions and the runtime must NOT add a parallel permissive policy:
                  // multiple PERMISSIVE policies are OR-combined by Postgres, so a runtime-added scope-only
                  // policy would silently bypass the migration's stricter ownership / dimension checks.
                  assertRlsManagementAllowed(
                    desc as Parameters<typeof assertRlsManagementAllowed>[0],
                  )
                  const rlsManagedByMigration = (desc as any).rlsManagedBy === "migration"
                  const policyPrefix = `${entityName}_rls`
                  // Always drop any stale runtime-generated policies (named `<entity>_rls_<op>`). This
                  // also cleans up policies left over from a prior run before `rlsManagedBy` was set.
                  for (const op of ["select", "insert", "update", "delete"]) {
                    await tx.execute(
                      drizzleSql.raw(
                        `DROP POLICY IF EXISTS ${quoteIdent(`${policyPrefix}_${op}`)} ON ${quoteIdent(schemaName)}.${quoteIdent(entityName)};`,
                      ),
                    )
                  }
                  if (rlsManagedByMigration) {
                    // The migration owns the policies, never the switch: a table that
                    // reaches registration without ENABLE + FORCE is closed here.
                    // Only when it is missing: the migration's owner role owns the table,
                    // and ALTER TABLE needs ownership.
                    const state = extractRows<{ rls: boolean; forced: boolean }>(
                      await tx.execute(drizzleSql`
                  SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
                  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = ${schemaName} AND c.relname = ${entityName}`),
                    )[0]
                    if (state && !(state.rls && state.forced)) {
                      for (const stmt of forceRlsStatements(schemaName, entityName)) {
                        await tx.execute(drizzleSql.raw(stmt))
                      }
                    }
                  } else {
                    // A table may declare `rlsScope` to gate RLS on a coarser LOGICAL
                    // scope-entity than its physical table name (e.g. `document_lines`
                    // → `documents`, `issuer_profiles` → `settings`). This decouples the
                    // physical schema from the app's declared grantable scope vocabulary
                    // so least-privilege roles can actually reach every table (see
                    // rls-generator.tablesUnreachableByGrantableScopes).
                    const rlsScopeEntity = rlsScopeEntityForTable(entityName, entityDef)
                    // A table may declare `internalWriteScope` (e.g. social `finding` →
                    // `social:internal`) so its UNGATED internal-mutation tools (set_triage /
                    // dismiss_finding) can WRITE under that scope even though the table's RLS
                    // scope-entity is a different, gated family (`findings`). Without this an
                    // internal-scope-only context (a triage-only routine ceiling) passes the
                    // tool scope check but its UPDATE is silently RLS-denied (0 rows, no error).
                    const internalWriteScope =
                      typeof (entityDef as { internalWriteScope?: unknown }).internalWriteScope ===
                      "string"
                        ? ((entityDef as { internalWriteScope?: string })
                            .internalWriteScope as string)
                        : undefined
                    // A table may declare `personalScope` so rows belonging to a
                    // PERSONAL account (effective visibility 'personal') are readable/
                    // writable ONLY by the account owner — broad scopes and dimension
                    // wildcards no longer pierce them (mail privacy, tier 2).
                    const personalScope = (entityDef as { personalScope?: unknown })
                      .personalScope as { via?: { table: string; localColumn: string } } | undefined
                    const policySql = generateRlsPolicySql(
                      schemaName,
                      entityName,
                      entityDef.dimensions ?? {},
                      desc.name,
                      rlsScopeEntity,
                      entityDef.fields ?? {},
                      internalWriteScope,
                      personalScope,
                    )
                    for (const stmt of policySql.split(";").filter((s: string) => s.trim())) {
                      try {
                        await tx.execute(drizzleSql.raw(`${stmt};`))
                      } catch (err: any) {
                        if (err.message?.includes("already exists")) continue
                        log.error(
                          { err: err.message, stmt: stmt.slice(0, 100) },
                          "RLS policy SQL error",
                        )
                        throw err
                      }
                    }
                  }

                  registerEntityDeclarations(desc, orgId, entityName, entityDef)
                }
              }

              // Grant runtime roles access to newly created tables (after table/RLS creation).
              // Runtime tests can drop/recreate app schemas, so explicit post-DDL grants are
              // required even when default privileges were configured earlier in registration.
              try {
                for (const role of ["liaison_rls", "liaison_admin"] as const) {
                  if (role === "liaison_rls") {
                    // Takes back TRUNCATE/TRIGGER an older registration granted (same transaction).
                    await tx.execute(
                      drizzleSql.raw(
                        `REVOKE ALL ON ALL TABLES IN SCHEMA ${quoteIdent(schemaName)} FROM ${role}`,
                      ),
                    )
                  }
                  await tx.execute(
                    drizzleSql.raw(
                      `GRANT ${tablePrivilegesFor(role)} ON ALL TABLES IN SCHEMA ${quoteIdent(schemaName)} TO ${role}`,
                    ),
                  )
                  await tx.execute(
                    drizzleSql.raw(
                      `GRANT ALL ON ALL SEQUENCES IN SCHEMA ${quoteIdent(schemaName)} TO ${role}`,
                    ),
                  )
                }
              } catch (err: any) {
                const code = err.code ?? err.cause?.code
                if (code === "42704") {
                  log.debug({ schemaName }, "runtime role not found, skipping post-table grants")
                } else {
                  log.warn({ err, schemaName }, "Failed to grant table access to runtime roles")
                }
              }

              // The SECURITY DEFINER search-ACL recompute (migration 0178) runs as
              // liaison_definer on every shareable table. Its grants live on the table,
              // so a registration that (re)created one would leave the recompute
              // failing with 42501; re-assert them after the DDL, as above.
              await grantDefinerOnShareableTables(tx, schemaName)

              // Mailbox encryption: re-assert the schema facts whose numbered migrations
              // normally no-op. The prod deploy runs the `migrate` one-shot BEFORE the app
              // containers are recreated, so on the deploy that lands the feature the
              // ciphertext and `encryption_state` columns do not exist yet when those
              // migrations run: each skips, records its journal row, and never runs again.
              // This step runs after the columns are guaranteed to exist, in every full
              // registration (a manifest, code or migration change makes the stamp stale),
              // and every statement it issues is conditional.
              if (desc.name === "mail") {
                const { assertMailboxSchemaState } = await import(
                  "~/modules/mailbox-crypto/post-sync-assertions"
                )
                await assertMailboxSchemaState(tx as any, schemaName)
              }

              if (!opts.skipOrgRows) await writeOrgAppRows(tx, desc, orgId)
              // Stamp the schema with what was just applied, so the next registration
              // of this app (any org, any process) can tell it is current.
              await stampAppSchema(tx, schemaName, ddlStamp)
              return true
            }), // End DDL + apps-upsert transaction
        )
      // In a setup lane (`serializeDdl`), an app schema that is already current
      // costs this org a reads-and-rows transaction beside other orgs' setups;
      // only a transaction that may change the schema waits in the lane, and it
      // looks again there (another org may just have brought it current).
      const reusedBesideLane =
        opts.serializeDdl != null && appSchemaDdlReuse.enabled && (await schemaTransaction(true))
      // The schema as it stands, when a re-apply is deferred (`appDdlDeferral`):
      // once fully applied (a stamp) and every declared column present.
      const registerOnExistingSchema = (): Promise<boolean> =>
        withSchemaAdmin(orgId, `register-app-rows:${desc.name}`, async (tx) => {
          const [row] = extractRows<{ stamp: string | null }>(
            await tx.execute(drizzleSql`
              SELECT obj_description(n.oid, 'pg_namespace') AS stamp
              FROM pg_namespace n WHERE n.nspname = ${schemaName}
            `),
          )
          if (!row?.stamp?.startsWith(APP_DDL_STAMP_PREFIX)) return false
          if ((await findDriftedSchemaObjects(desc, orgId, tx)).length > 0) return false
          for (const [entityName, entityDef] of sortEntitiesByFk(
            (desc.schema ?? {}) as Record<string, any>,
          )) {
            registerEntityDeclarations(desc, orgId, entityName, entityDef)
          }
          if (!opts.skipOrgRows) await writeOrgAppRows(tx, desc, orgId)
          appRegistrationStats.ddlDeferred++
          return true
        })
      if (!reusedBesideLane) {
        const failedAt = appDdlFailedAt.get(manifestKey)
        const deferred =
          failedAt !== undefined &&
          Date.now() - failedAt < appDdlDeferral.cooldownMs &&
          (await registerOnExistingSchema())
        if (!deferred) {
          const serializeDdl = opts.serializeDdl ?? (<T>(task: () => Promise<T>) => task())
          try {
            await serializeDdl(() => schemaTransaction(false))
            appDdlFailedAt.delete(manifestKey)
          } catch (err) {
            if (!isDdlLockConflict(err)) throw err
            // Rolled back: the schema is not current, the lane must look again later.
            ranSchemaDdl = false
            appDdlFailedAt.set(manifestKey, Date.now())
            if (!(await registerOnExistingSchema())) throw err
            log.warn(
              {
                app: desc.name,
                orgId,
                sqlState: describeDbError(err).code,
                retryAfterMs: appDdlDeferral.cooldownMs,
              },
              "App schema re-apply lost its locks: this org runs on the existing schema, the re-apply is retried after the cool-down",
            )
          }
        }
      }
      if (ranSchemaDdl) currentAppSchemaKeys.add(manifestKey)
    }

    // The files SELECT policy comes from the catalog and names only parents
    // whose table exists (boot-phase10.ts). This DDL may just have created a
    // catalog app's parent table: rebuild it now so those files become
    // readable (no DDL when the policy is already current).
    if (ranSchemaDdl && declaresFileParent(desc)) {
      try {
        const { rebuildFilesSelectPolicy } = await import("~/infra/boot-phase10")
        await rebuildFilesSelectPolicy()
      } catch (err) {
        log.warn({ err, app: desc.name }, "Rebuilding the files policy after app schema DDL failed")
      }
    }

    // The row is committed: an org state loaded before this app existed for the
    // org lists it now (the admin's App store, add / enable), not after the TTL.
    noteAppRegistered(orgId, desc.name)

    // Post-transaction in-memory registration — wrapped in try/catch so partial
    // registration doesn't leave the app marked as registered without its registries.
    try {
      const isManifestFormat = (desc as any)._format === "manifest"
      const bundlePath = (desc as any)._bundlePath
      const oauthClientResolvers = (desc as any)._oauthClientResolvers
      const bridgeExtension: BridgeExtensionFactory | undefined = desc._bridgeExtension

      // Build minimal manifest for RPC bridge — available for tools, events, and jobs.
      // Mirrored by modules/apps/bridge-manifest.ts (the CLI's installed import
      // kinds, which never register): keep the two field lists in step.
      const declaredCapabilities: string[] = (desc as any).capabilities ?? []
      const projection = sharedProjectionOf(desc)
      const builtManifestForBridge = projection?.manifestForBridge
      const manifestForBridge =
        builtManifestForBridge !== undefined
          ? builtManifestForBridge
          : isManifestFormat
            ? buildManifestForBridge(desc, declaredCapabilities)
            : null
      if (projection && builtManifestForBridge === undefined) {
        if (manifestForBridge) Object.freeze(manifestForBridge)
        projection.manifestForBridge = manifestForBridge
      }

      // Capability registry — read by `tool-bridge.ts` to gate capability-scoped
      // kernel tools (e.g. `kernel:spawn_agent` only surfaces when ≥1 installed
      // app declares `agent.spawn`). Populated for both manifest and legacy
      // descriptors; an app that declares no capabilities still records an
      // empty array so lookups never confuse "registered, no capabilities"
      // with "not yet registered".
      appCapabilitiesRegistry.set([orgId, desc.name], declaredCapabilities)

      // Bridge-manifest registry — the full manifest snapshot (with schema +
      // erasure declarations) for EVERY installed manifest-format app, including
      // tool-less/webhook-less ones whose schema would otherwise be unreachable.
      // Compliance paths (GDPR erasure) enumerate this off the live registry.
      if (manifestForBridge) {
        appBridgeManifestRegistry.set([orgId, desc.name], manifestForBridge)
      }

      // Register tools — manifest format stores handler tuples, legacy format stores functions
      if (desc.tools) {
        for (const [toolName, tool] of Object.entries(desc.tools as Record<string, any>)) {
          // Org-independent: built once per manifest and shared (sharedProjectionOf).
          let entry: any = projection?.tools.get(toolName)
          if (!entry) {
            entry = {
              appName: desc.name,
              name: toolName,
              description: tool.description,
              requiredScopes: tool.requiredScopes,
              gated: tool.gated,
              // Handler-conditional gating. Carried through so the stage-time
              // preflight hook can cover a tool that parks an approval from
              // inside its handler, not just a declaratively-gated one.
              conditionalGate: tool.conditionalGate,
              preflight:
                isManifestFormat && tool.preflight
                  ? { bundlePath, exportName: tool.preflight, trusted: desc.trusted !== false }
                  : tool.preflight,
              handler: isManifestFormat
                ? { bundlePath, exportName: tool.handler, trusted: desc.trusted !== false }
                : tool.handler,
              params: tool.params,
              returns: tool.returns,
              trustBoundary: tool.trustBoundary,
              instructions: tool.instructions,
              taintSource: tool.taintSource,
              externalEffect: tool.externalEffect,
              retryOnTransientDbError: tool.retryOnTransientDbError,
              // Bridge-owned transactions escape hatch: `atomic: true` keeps this
              // tool's whole handler run inside ONE ambient RLS transaction (the
              // pre-session legacy contract) — for multi-write handlers whose
              // failure paths rely on whole-run rollback. Everything else runs
              // each bridge call in its own short transaction (executeToolHandler).
              // TRUSTED apps only: a third-party .liaisonapp must not opt back
              // into pinning a pool connection for its whole sandbox run.
              atomic: tool.atomic === true && desc.trusted !== false,
            }
            if (manifestForBridge) entry._manifest = manifestForBridge
            // Scope-taint declarations. A write target counts only inside the app's
            // own schema, so no app can pass itself off as a kernel or another app's
            // sink; a dropped one leaves the tool an undeclared write (refused on a
            // tainted turn). readOnly is a self-declaration, honoured for a trusted
            // app and for a sandboxed app SOMEONE OUTSIDE THE MANIFEST vouched for:
            // `_firstParty` (an in-tree app, or an install whose artifact is the
            // image's own catalog tarball) is the platform's voucher, and
            // `_publisherSigned` (this install's artifact carries a cosign signature
            // verified against the instance's configured trusted-publisher identity)
            // is the operator's own, taken at install time. Both are set by init.ts,
            // never by the manifest. An unsigned third-party sandboxed app's claim
            // proves nothing and is ignored.
            if (
              typeof tool.writesToTable === "string" &&
              tool.writesToTable.startsWith(`app_${desc.name.replace(/-/g, "_")}.`)
            ) {
              entry.writesToTable = tool.writesToTable
            } else if (
              // VOUCHED KERNEL SINK. A first-party app (in-tree, or the image's own catalog
              // tarball) may name a kernel ENFORCING sink it really writes through a kernel
              // bridge: projects' task comments are kernel.messages rows stamped with the
              // turn's scopes. The platform vouches for the code, so the claim is judged like
              // a kernel tool's. A third-party app, signed by the operator's publisher or not,
              // never can: its claim would let it pose as the sink that allows every write.
              typeof tool.writesToTable === "string" &&
              tool.writesToTable.startsWith("kernel.") &&
              TAINT_ENFORCING_SINKS.has(tool.writesToTable) &&
              (desc.trusted !== false || desc._firstParty === true)
            ) {
              entry.writesToTable = tool.writesToTable
            }
            if (
              tool.readOnly === true &&
              (desc.trusted !== false ||
                desc._firstParty === true ||
                desc._publisherSigned === true)
            ) {
              entry.readOnly = true
            }
            // The sink's reader scope (scope-taint.ts, consequence 4). It turns a refusal into
            // an audience judgement, so it is a claim about who reads the table and is vouched
            // for exactly like readOnly. It must name a scope in the app's own namespace (an
            // app cannot describe another app's readers) and only rides a kept writesToTable.
            if (
              typeof tool.sinkReadScope === "string" &&
              entry.writesToTable !== undefined &&
              tool.sinkReadScope.startsWith(`${desc.name}:`) &&
              (desc.trusted !== false ||
                desc._firstParty === true ||
                desc._publisherSigned === true)
            ) {
              entry.sinkReadScope = tool.sinkReadScope
            }
            // No declared readers: an app-schema table defaults to the readers its generated RLS
            // admits (scope-taint.ts, rule 6a), vouched for exactly like a declared one, since
            // `writesToTable` is itself the app's claim about where its data lands. A table whose
            // readers cannot be derived keeps no sinkReadScope and is refused as before.
            if (
              entry.sinkReadScope === undefined &&
              entry.writesToTable !== undefined &&
              (desc.trusted !== false ||
                desc._firstParty === true ||
                desc._publisherSigned === true)
            ) {
              const derived = derivedSinkReadScope({
                appName: desc.name,
                writesToTable: entry.writesToTable,
                schema: (desc.schema as Record<string, unknown> | undefined) ?? null,
                rlsManagedByMigration:
                  (desc as { rlsManagedBy?: unknown }).rlsManagedBy === "migration",
              })
              if (derived !== undefined) entry.sinkReadScope = derived
            }
            // Same-resource allowance (A46). Both halves follow `writesToTable`'s rule:
            // a table counts only inside the app's own schema, so no app can claim
            // another's rows as its taint origin, and a dropped declaration simply
            // leaves the tool without the allowance.
            if (
              typeof tool.readsFromTable === "string" &&
              tool.readsFromTable.startsWith(`app_${desc.name.replace(/-/g, "_")}.`)
            ) {
              entry.readsFromTable = tool.readsFromTable
            }
            if (typeof tool.targetRowParam === "string" && tool.targetRowParam.length > 0) {
              entry.targetRowParam = tool.targetRowParam
            }
            // A46b: the path to the ids in the read's RESULT. It widens nothing on its
            // own (an origin still needs the table, the row parameter and the scopes);
            // it only says where to look for what the read returned.
            if (typeof tool.resultRowPath === "string" && tool.resultRowPath.length > 0) {
              entry.resultRowPath = tool.resultRowPath
            }
            if (tool.approvalImpact === "external" || tool.approvalImpact === "internal") {
              entry.approvalImpact = tool.approvalImpact
            }
            // Approvals for this tool must be decided FROM THE RECORD, so the
            // attention feed offers only a way in. This registry entry is built by
            // COPYING named fields off the manifest tool, so a field that is not
            // copied here is invisible to every reader of the registry no matter
            // what the manifest says: shipping the manifest flag + the UI without
            // this line left ticket-reply approvals fully decidable in the feed
            // (2026-08-05). Mirrors approvalImpact directly above.
            if (typeof tool.decideInContext === "boolean") {
              entry.decideInContext = tool.decideInContext
            }
            if (typeof tool.deferLoading === "boolean") entry.deferLoading = tool.deferLoading
            if (Array.isArray(tool.searchKeywords)) entry.searchKeywords = tool.searchKeywords
            // Per-tool sandbox execution budget (see manifest-schema toolSchema.timeoutMs).
            if (typeof tool.timeoutMs === "number") entry.timeoutMs = tool.timeoutMs
            if (typeof tool.agentVisible === "boolean") entry.agentVisible = tool.agentVisible
            // Provider-contract op (dispatch-only) and the no-auto-approve gate flag; both read by
            // executeToolCore (execute-tool.ts), so they must be copied here or they read undefined.
            if (tool.contractOnly === true) entry.contractOnly = true
            if (tool.noAutoApprove === true) entry.noAutoApprove = true
            // Pinned params: dropped from a caller's call, set only by the preflight.
            if (Array.isArray(tool.pinnedParams)) entry.pinnedParams = tool.pinnedParams
            // A call chaining `@ref` tokens to a tool with pinned params stages unpinned (read by
            // execute-tool.ts); the pinned-drop above still applies.
            if (tool.pinnedOptionalOnRefs === true) entry.pinnedOptionalOnRefs = true
            if (tool.approvalCard !== null && typeof tool.approvalCard === "object") {
              entry.approvalCard = tool.approvalCard
            }
            // Declarations the card, roll-up, feature gate, focus budget, taint and hidden-tool
            // redirect readers take off the entry. Each one must be copied here or it reads
            // undefined, whatever the manifest says (see the note above `decideInContext`).
            if (tool.resultCard !== null && typeof tool.resultCard === "object") {
              entry.resultCard = tool.resultCard
            }
            if (typeof tool.runningLabel === "string") entry.runningLabel = tool.runningLabel
            if (typeof tool.runningLabelKey === "string") {
              entry.runningLabelKey = tool.runningLabelKey
            }
            if (typeof tool.feature === "string") entry.feature = tool.feature
            if (tool.focusCore === true || typeof tool.focusCore === "string") {
              entry.focusCore = tool.focusCore
            }
            if (typeof tool.useInstead === "string") entry.useInstead = tool.useInstead
            // The manifest's row condition. It lands beside, not on, the host-only
            // `taintSourceWhen` function that taint.ts calls.
            if (tool.taintSourceWhen !== null && typeof tool.taintSourceWhen === "object") {
              entry.taintSourceWhenRow = tool.taintSourceWhen
            }
            // What a tool writes is read only by the person writing it: it narrows a scope-taint
            // refusal, so it counts for a first-party app alone (registration refuses any other).
            if (hasPrivilegedBridge(desc)) {
              if (tool.sinkReadersSelf === true) entry.sinkReadersSelf = true
              if (Array.isArray(tool.contentParams)) entry.contentParams = tool.contentParams
            }
            // Outbound text params: a placeholder there is refused before any gate (execute-tool.ts).
            if (Array.isArray(tool.outboundTextParams)) {
              entry.outboundTextParams = tool.outboundTextParams
            }
            if (Array.isArray(tool.referenceableOutputs)) {
              entry.referenceableOutputs = tool.referenceableOutputs
            }
            if (typeof tool.poll === "function") entry.poll = tool.poll
            // Async-output polling for SANDBOXED manifest tools: `pollHandler`
            // names a bundle export. The kernel's approval-poll job calls
            // entry.poll on the poll schedule; this wrapper executes the export
            // in the worker pool with `{ external_ref }` (the ref the handler
            // recorded via ctx.approval_recordAwaitingOutput) and normalizes its
            // `{ ready, result }` return. When ready, poll-output.ts writes the
            // result and resumes the sequence cascade — deferred dependents get
            // the materialized outputs instead of failing on a null @ref.
            if (
              isManifestFormat &&
              typeof tool.pollHandler === "string" &&
              tool.pollHandler !== ""
            ) {
              const pollExport = tool.pollHandler as string
              const pollBundlePath = bundlePath
              const pollAppName = desc.name
              const pollManifest = manifestForBridge
              const pollPrivileged = hasPrivilegedBridge(desc)
              entry.poll = async (
                pollCtx: { orgId: string; userId: string; tx: unknown },
                externalRef: unknown,
              ): Promise<{ ready: boolean; result?: Record<string, unknown> }> => {
                const { getWorkerPool, initWorkerPool } = await import(
                  "~/modules/apps/sandbox/worker-pool"
                )
                const { createSandboxRpcBridge } = await import("~/modules/apps/sandbox/rpc-bridge")
                const source = await loadBundle(pollBundlePath)
                const runPoll = async (tx: unknown) => {
                  const bridge = createSandboxRpcBridge(
                    pollAppName,
                    `system:${pollAppName}:poll`,
                    pollCtx.orgId,
                    tx as never,
                    pollManifest as never,
                  )
                  await initWorkerPool()
                  return getWorkerPool().execute({
                    bundleSource: source,
                    exportName: pollExport,
                    params: { external_ref: externalRef },
                    bridge,
                    timeoutMs: 60_000,
                    priority: "background",
                    appId: pollAppName,
                  })
                }
                // The poll job hands over a privileged transaction. An app the
                // platform does not vouch for polls as itself, under RLS.
                const out = pollPrivileged
                  ? await (async () => {
                      // As the app, like its privileged event handlers: a scope
                      // check in the database reads the scopes its manifest declares.
                      const { setPrivilegedContext } = await import("~/db/privileged")
                      await setPrivilegedContext(
                        pollCtx.tx as Pick<RlsClient, "execute">,
                        pollCtx.orgId,
                        {
                          scopes: pollManifest?.scopes ?? [],
                        },
                      )
                      return runPoll(pollCtx.tx)
                    })()
                  : await (await import("~/db/rls")).withRlsContext(
                      {
                        actorType: "system",
                        orgId: pollCtx.orgId,
                        purpose: "job",
                        scopes: [`${pollAppName}:*`],
                      },
                      runPoll,
                      { pool: "jobs" },
                    )
                const r = out as { ready?: unknown; result?: unknown } | null
                return r && r.ready === true
                  ? { ready: true, result: (r.result ?? {}) as Record<string, unknown> }
                  : { ready: false }
              }
            }
            assertReferenceableOutputs(`${desc.name}:${toolName}`, entry.referenceableOutputs)
            if (projection) projection.tools.set(toolName, Object.freeze(entry))
          }
          toolRegistry.set([orgId, desc.name, toolName], entry)

          if (Array.isArray(tool.editableFields) && tool.editableFields.length > 0) {
            approvalEditableFieldsRegistry.set([orgId, desc.name, toolName], tool.editableFields)
          }
          if (typeof tool.approvalExpiryHours === "number") {
            approvalExpiryRegistry.set([orgId, desc.name, toolName], tool.approvalExpiryHours)
          }
          if (
            typeof tool.approvalDedupeKeyParam === "string" &&
            tool.approvalDedupeKeyParam !== ""
          ) {
            approvalDedupeKeyRegistry.set([orgId, desc.name, toolName], tool.approvalDedupeKeyParam)
            if (tool.approvalDedupeSameRequester === true) {
              approvalDedupeSameRequesterRegistry.set([orgId, desc.name, toolName], true)
            }
          }
          // Declarative resource-owner resolution (privacy routing): a gated
          // tool targeting a personally-owned resource routes its approval to
          // the owner alone. Interpreted host-side by
          // modules/approvals/resource-owner.ts — no app code runs.
          if (
            tool.resourceOwner?.requester &&
            typeof tool.resourceOwner.requester.param === "string" &&
            typeof tool.resourceOwner.requester.equals === "string"
          ) {
            approvalResourceOwnerRegistry.set([orgId, desc.name, toolName], {
              requester: {
                param: tool.resourceOwner.requester.param,
                equals: tool.resourceOwner.requester.equals,
              },
            })
          } else if (
            tool.resourceOwner &&
            typeof tool.resourceOwner.table === "string" &&
            typeof tool.resourceOwner.param === "string"
          ) {
            approvalResourceOwnerRegistry.set([orgId, desc.name, toolName], {
              table: tool.resourceOwner.table,
              param: tool.resourceOwner.param,
              ...(tool.resourceOwner.account &&
              typeof tool.resourceOwner.account.table === "string" &&
              typeof tool.resourceOwner.account.column === "string"
                ? {
                    account: {
                      table: tool.resourceOwner.account.table,
                      column: tool.resourceOwner.account.column,
                    },
                  }
                : {}),
            })
          }

          if (isManifestFormat && tool.summarizer) {
            if (desc.trusted === false && isSummarizerTrustCarveOutAllowed(desc.name)) {
              // Operator-explicit carve-out (LIAISON_TRUSTED_SUMMARIZER_APPS): run
              // the summarizer HOST-SIDE. Kept ahead of the sandbox path below
              // because a summarizer that reads current state (a before/after
              // preview) cannot be served by the empty-bridge sandbox.
              log.warn(
                { app: desc.name, toolName },
                "Registering summarizer for untrusted manifest app via LIAISON_TRUSTED_SUMMARIZER_APPS operator override",
              )
              const summarize = await loadTrustedBundleFunction(bundlePath, tool.summarizer)
              registerApprovalSummarizer(
                orgId,
                desc.name,
                toolName,
                summarize as ApprovalSummarizer,
              )
            } else if (desc.trusted === false) {
              // Untrusted bundle code must not run host-side, but it CAN run
              // in the same QuickJS sandbox its handlers run in. The
              // summarizer executes with an EMPTY bridge (no db/http/kernel
              // access): a pure params -> ApprovalSummary transformation whose
              // output generateApprovalSummary validates and bounds host-side
              // exactly like a trusted summarizer's. Previously these were
              // skipped wholesale, so every bundled-app approval (shopify,
              // meta-ads, boxtal, ...) fell back to the raw-params summary.
              // (Summarizers that need I/O, such as a before/after preview,
              // must be operator-allowlisted for the host-side path above;
              // under the empty bridge they degrade to a "preview unavailable"
              // card rather than a real diff.)
              const summarizerName = tool.summarizer
              const summarizerBundlePath = bundlePath
              const summarizerAppName = desc.name
              const summarizerContext = tool.summarizerContext as
                | { tool: string; params: Record<string, string> }
                | undefined
              const summarize: ApprovalSummarizer = async (params, sctx) => {
                const { loadBundle } = await import("~/modules/apps/sandbox/bundle-loader")
                const { executeInSandbox } = await import("~/modules/apps/sandbox/executor")
                const { getSandboxPool } = await import("~/modules/apps/sandbox/pool")
                const meta = await buildSummarizerMeta(
                  orgId,
                  summarizerAppName,
                  summarizerContext,
                  params,
                  sctx.actor,
                )
                const source = await loadBundle(summarizerBundlePath)
                return (await executeInSandbox({
                  pool: getSandboxPool(),
                  bundleSource: source,
                  exportName: summarizerName,
                  params,
                  extraArgs: [meta],
                  bridge: {},
                  timeoutMs: 5_000,
                })) as Awaited<ReturnType<ApprovalSummarizer>>
              }
              registerApprovalSummarizer(orgId, desc.name, toolName, summarize)
            } else {
              // Trusted summarizers get the SAME meta (identifier + hydrated
              // context) as sandboxed ones — parity so a card is equally rich
              // regardless of the app's trust tier.
              const inner = (await loadTrustedBundleFunction(
                bundlePath,
                tool.summarizer,
              )) as ApprovalSummarizer
              const trustedAppName = desc.name
              const trustedContext = tool.summarizerContext as
                | { tool: string; params: Record<string, string> }
                | undefined
              const summarize: ApprovalSummarizer = async (params, sctx) =>
                inner(
                  params,
                  sctx,
                  await buildSummarizerMeta(
                    orgId,
                    trustedAppName,
                    trustedContext,
                    params,
                    sctx.actor,
                  ),
                )
              registerApprovalSummarizer(orgId, desc.name, toolName, summarize)
            }
          } else if (
            isManifestFormat &&
            (tool.gated === true || tool.conditionalGate === true) &&
            typeof tool.approvalCard?.summary === "string"
          ) {
            // A gated tool with no summarizer but an `approvalCard.summary`
            // template ("Create inbox {{params.name}}"): the template titles
            // its card, instead of the bare tool id.
            registerApprovalSummarizer(
              orgId,
              desc.name,
              toolName,
              templateApprovalSummarizer(tool.approvalCard.summary, `${desc.name}:${toolName}`),
            )
          }
        }
      }

      // Register app-level agent instructions.
      if (desc.agentInstructions) {
        agentInstructionsRegistry.set([orgId, desc.name], desc.agentInstructions)
      }

      // Register built-in user-facing skills (declared in the app descriptor).
      // User/org skills live in `kernel.skills` and are merged at context-assembly time.
      //
      // `body` may be a string or a lazy `() => Promise<string>` (per contract).
      // Resolve lazy bodies once at register time so the registry holds plain
      // strings — failure throws and aborts app registration (per spec).
      if (desc.skills) {
        for (const [skillName, skillDef] of Object.entries(desc.skills as Record<string, any>)) {
          let resolvedBody: string
          if (typeof skillDef.body === "function") {
            try {
              const out = await (skillDef.body as () => string | Promise<string>)()
              if (typeof out !== "string" || out.length === 0) {
                throw new Error(`skill ${skillName} body loader returned non-string or empty value`)
              }
              resolvedBody = out
            } catch (err) {
              throw new Error(
                `Failed to load body for built-in skill ${desc.name}/${skillName}: ${(err as Error).message}`,
              )
            }
          } else {
            resolvedBody = skillDef.body
          }
          skillRegistry.set([orgId, desc.name, skillName], {
            name: skillName,
            description: skillDef.description,
            body: resolvedBody,
            requiredScopes: skillDef.requiredScopes ?? [],
            kind: skillDef.kind ?? "playbook",
            enabledByDefault: skillDef.enabledByDefault ?? true,
            autoAttach: skillDef.autoAttach ?? null,
          })
        }
      }

      // Component A — populate routine templates + seed agent assets (per-org,
      // post-DDL, idempotent). `reconcileAgents` may throw on a ceiling
      // violation; let it abort registration loudly (matches the skill-body
      // loader throw behavior).
      if (desc.routines) {
        for (const [key, t] of Object.entries(
          desc.routines as Record<string, import("~/modules/apps/contract").AppRoutineTemplate>,
        )) {
          routineTemplateRegistry.set([orgId, desc.name, key], {
            description: t.description,
            kind: t.kind,
            cron: t.cron,
            timezone: t.timezone,
            runAt: t.runAt,
            event: t.event,
            promptTemplate: t.promptTemplate,
            scopes: t.scopes,
            enabledByDefault: t.enabledByDefault,
            ...(t.followUp ? { followUp: true } : {}),
          })
        }
      }
      if (desc.skills) {
        const skillDecls = Object.entries(
          desc.skills as Record<string, import("~/modules/apps/contract").AppBuiltinSkill>,
        ).map(([name, d]) => ({ name, enabledByDefault: d.enabledByDefault ?? true }))
        await reconcileDefaultDisabledSkills(orgId, desc.name, skillDecls)
      }
      if (desc.agents) {
        // App "granted scopes" = the union of the app's declared tool scopes
        // (the canonical capability surface; there is no `desc.scopes`).
        const appGrantedScopes = Array.from(
          new Set(
            Object.values((desc.tools ?? {}) as Record<string, { requiredScopes?: string[] }>)
              .flatMap((t) => t.requiredScopes ?? [])
              .filter((s): s is string => Boolean(s)),
          ),
        )
        await reconcileAgents(
          orgId,
          desc.name,
          desc.agents as Record<string, import("~/modules/apps/contract").AppAgentDecl>,
          appGrantedScopes,
        )
      }
      // Reinstall/re-enable: resume any routines a prior uninstall paused
      // (status='paused_app_disabled'), re-subscribing event routines. A
      // user's own `paused_user` routines are left paused (Task A12). An app
      // turned Off for the workspace keeps its routines paused (S19).
      if (await isAppActiveForOrgAsync(orgId, desc.name)) {
        await resumeAppRoutinesForOrg(orgId, desc.name)
      }

      // Register app-internal prompts (e.g., tickets/summarizer).
      if ((desc as any).prompts) {
        for (const [promptName, promptDef] of Object.entries(
          (desc as any).prompts as Record<string, { content: string }>,
        )) {
          appPromptRegistry.set([orgId, desc.name, promptName], {
            content: promptDef.content,
          })
        }
      }

      // Record cross-app tool dependencies for the trust check in executeToolCore.
      if ((desc as any).dependencies?.tools) {
        appDependenciesRegistry.set([orgId, desc.name], {
          tools: (desc as any).dependencies.tools as string[],
        })
      }

      // Record install-approved cross-app tool capabilities (manifest
      // `cross_app_calls[].target`). These authorize app↔app (`internalCall`)
      // dispatch in executeToolCore independent of the caller's RBAC scopes —
      // the operator approved the declaration at install. Event-driven handlers
      // run as a bare `${app}:*` system actor, so without this every automatic
      // cross-app call (customs fetch, order enrichment, product sync, auto-email)
      // is rejected `forbidden: missing scope`.
      if (Array.isArray((desc as any).cross_app_calls)) {
        const targets = ((desc as any).cross_app_calls as Array<{ target?: unknown }>)
          .map((c) => c.target)
          .filter((t): t is string => typeof t === "string" && t.length > 0)
        if (targets.length > 0) {
          appCrossAppCallsRegistry.set([orgId, desc.name], { targets })
        }
      }

      // Provider contracts (`implements` / `contract_calls`), validated at registration by
      // provider-contracts/validate.ts. Resolution and the contract dispatch read these.
      if (Array.isArray((desc as any).implements)) {
        const impls: Record<string, { ops: Record<string, string> }> = {}
        for (const impl of (desc as any).implements as Array<{
          contract: string
          version: number
          tools: Record<string, string>
        }>) {
          impls[`${impl.contract}@${impl.version}`] = { ops: { ...impl.tools } }
        }
        appContractImplementationsRegistry.set([orgId, desc.name], impls)
      }
      if (Array.isArray((desc as any).contract_calls)) {
        const calls: Record<string, { bindingSetting: string }> = {}
        for (const c of (desc as any).contract_calls as Array<{
          contract: string
          bindingSetting: string
        }>) {
          calls[c.contract] = { bindingSetting: c.bindingSetting }
        }
        appContractCallsRegistry.set([orgId, desc.name], calls)
      }

      // Record settings schemas / defaults for the sandbox bridge, and the
      // declarative settings page, all derived from the manifest `settings`, so
      // in-tree, bundled and installed apps are treated alike.
      // Org-independent: built once per manifest and shared (sharedProjectionOf).
      if (projection && !projection.settings) {
        projection.settings = { value: buildAppSettingsEntry(desc) }
      }
      const settingsEntry = projection?.settings
        ? projection.settings.value
        : buildAppSettingsEntry(desc)
      if (settingsEntry) appSettingsRegistry.set([orgId, desc.name], settingsEntry)

      // Per-app attention items provider hook.
      const attDecl = (desc as any).views?.attentionItems
      if (attDecl && isManifestFormat) {
        const handler = typeof attDecl === "string" ? attDecl : attDecl.handler
        const explicitScope = typeof attDecl === "object" ? attDecl.scope : undefined
        // Undeclared: the provider never receives anyone else's items to pass on.
        const passesOn = typeof attDecl === "object" && attDecl.passesOn === true
        const firstEntity = Object.keys((desc as any).schema ?? {})[0]
        const scope =
          explicitScope ?? (firstEntity ? `${desc.name}:${firstEntity}:read` : `${desc.name}:read`)
        attentionItemsRegistry.set([orgId, desc.name], {
          handler,
          scope,
          bundlePath,
          trusted: desc.trusted !== false,
          ...(passesOn ? { passesOn: true } : {}),
        })
      }

      // Register declared emits for event validation (org-scoped for multi-tenant isolation)
      if (desc.events?.emits) {
        setDeclaredEmits(orgId, desc.name, new Set(desc.events.emits as string[]))
      }

      // Register event subscriptions using the event bus subscribe function.
      // Disposers are collected so registration rollback + uninstall can tear
      // the subscriptions down (otherwise a reinstall stacks duplicate handlers).
      const subscriptionDisposers: Array<() => Promise<void>> = []
      if (desc.events?.subscribes) {
        for (const [eventType, handlerRef] of Object.entries(desc.events.subscribes)) {
          // eventType format: "entity:action" (same app) or "sourceApp/entity:action" (cross-app)
          let sourceApp: string
          let entity: string
          let action: string
          if (eventType.includes("/")) {
            const [src, rest] = eventType.split("/")
            sourceApp = src
            ;[entity, action] = rest.split(":")
            // Cross-app subscriptions require a declared dependency,
            // EXCEPT for kernel events which are always available
            if (sourceApp !== "kernel") {
              if (
                !desc.dependencies?.required?.includes(sourceApp) &&
                !desc.dependencies?.optional?.includes(sourceApp)
              ) {
                log.warn(
                  { app: desc.name, sourceApp },
                  "Cross-app event subscription without declared dependency — skipping",
                )
                continue
              }
            }
            // Warn if subscribing to an undeclared event from the source app
            const eventKey = `${entity}:${action}`
            const sourceEmits =
              getDeclaredEmits(orgId, sourceApp) ?? getDeclaredEmits("*", sourceApp)
            if (sourceEmits && !sourceEmits.has(eventKey)) {
              log.warn(
                { app: desc.name, sourceApp, eventKey },
                "Subscribed to undeclared cross-app event",
              )
            }
          } else {
            sourceApp = desc.name
            ;[entity, action] = eventType.split(":")
          }

          if (isManifestFormat && typeof handlerRef === "string") {
            // Manifest format: run handler in sandbox with a real RPC bridge
            const exportName = handlerRef
            const appName = desc.name
            const bridgeManifest = manifestForBridge!
            // Cross-app kernel events need privileged DB — the handler must see all rows
            // regardless of the original actor (user who connected the account).
            const isCrossAppKernel = sourceApp !== appName
            const handler = async (event: any) => {
              const { getWorkerPool, initWorkerPool } = await import(
                "~/modules/apps/sandbox/worker-pool"
              )
              const { createEventHandlerBridge } = await import(
                "~/modules/apps/sandbox/event-handler-bridge"
              )
              const source = await loadBundle(bundlePath)
              const eventOrgId: string = event.orgId ?? orgId
              const actorId: string = event.actorId ?? `system:${appName}`

              const runHandler = async (txDb: any) => {
                const bridge = createEventHandlerBridge({
                  appName,
                  actorId,
                  orgId: eventOrgId,
                  txDb,
                  manifest: bridgeManifest,
                  actorType:
                    event.actorType ??
                    (actorId === "system" || actorId.startsWith("system:") ? "system" : "user"),
                })
                // Event handlers execute in the OUT-OF-PROCESS worker pool, never on
                // the main thread's in-process QuickJS pool: an event burst (or one
                // slow handler) used to stall the host event loop in multi-second
                // synchronous chunks -- the post-deploy run-tool 504 class. Bridge
                // calls still arrive back on THIS process over IPC and run these
                // same closures, so the ambient jobs-pool transaction and RLS /
                // privileged wrappers behave exactly as before. Background priority:
                // events must not starve interactive tool calls (same rule as
                // manifest webhooks).
                await initWorkerPool()
                await getWorkerPool().execute({
                  bundleSource: source,
                  exportName,
                  params: event,
                  bridge,
                  timeoutMs: 30_000,
                  priority: "background",
                  appId: appName,
                })
              }

              // The handler's transaction holds a jobs connection for its whole
              // run: it waits for admission first (infra/jobs/pinned-jobs-gate.ts).
              // The wait ends when the event bus gives up on this handler
              // (its signal), and never outlasts the bus's handler timeout.
              const pinnedLabel = `event:${appName}:${exportName}`
              const admission = currentHandlerSignal() ?? AbortSignal.timeout(HANDLER_TIMEOUT_MS)
              if (
                (isCrossAppKernel || (event.actorType ?? "system") === "system") &&
                !hasPrivilegedBridge(desc)
              ) {
                // An app nobody vouched for never holds a handle that bypasses
                // RLS: its cross-app and system events run as the app itself,
                // under its own scopes, like its webhooks and crons.
                const { withRlsContext } = await import("~/db/rls")
                await withPinnedJobSlot(
                  pinnedLabel,
                  () =>
                    withRlsContext(
                      {
                        actorType: "system",
                        orgId: eventOrgId,
                        purpose: "job",
                        scopes: [`${appName}:*`],
                      },
                      runHandler,
                      { pool: "jobs" },
                    ),
                  admission,
                )
              } else if (isCrossAppKernel || (event.actorType ?? "system") === "system") {
                // Cross-app or system events: handler needs privileged DB to see all rows
                const { withPrivilegedDb } = await import("~/db/privileged")
                // Background pool: tx held across the sandboxed handler run —
                // keep the privileged pool free for short nested reads.
                // The handler acts as the app: a scope check in the database
                // (a task number, say) reads the scopes its manifest declares.
                // The built-in projects app declares none, and needs none: it
                // subscribes to no event and declares no poll, so no privileged
                // handler runs as it (its CI webhook runs under RLS as `projects:*`).
                await withPinnedJobSlot(
                  pinnedLabel,
                  () =>
                    withPrivilegedDb(eventOrgId, `event:${appName}:${exportName}`, runHandler, {
                      pool: "jobs",
                      actor: { scopes: bridgeManifest.scopes ?? [] },
                    }),
                  admission,
                )
              } else {
                // Same-app user/agent events: run under standard RLS context
                const { withRlsContext } = await import("~/db/rls")
                await withPinnedJobSlot(
                  pinnedLabel,
                  () =>
                    withRlsContext(
                      {
                        actorType: event.actorType,
                        userId: actorId,
                        orgId: eventOrgId,
                        scopes: [`${appName}:*`],
                        dimensionGrants: {},
                      },
                      runHandler,
                      // Event-subscription handlers run sandboxed with the tx held
                      // open — background pool, same as job handlers.
                      { pool: "jobs" },
                    ),
                  admission,
                )
              }
            }
            subscriptionDisposers.push(
              await subscribeToEvent(
                sourceApp,
                entity,
                action,
                gateEventOnAppState(desc.name, orgId, handler),
                // Once (A5): an app's subscription writes; it runs in the
                // publishing process only, not once per process.
                { delivery: "once", name: `app-subscription:${desc.name}` },
              ),
            )
          } else {
            subscriptionDisposers.push(
              await subscribeToEvent(
                sourceApp,
                entity,
                action,
                gateEventOnAppState(desc.name, orgId, handlerRef as (event: any) => Promise<void>),
                { delivery: "once", name: `app-subscription:${desc.name}` },
              ),
            )
          }
        }
      }
      if (subscriptionDisposers.length > 0) {
        eventSubscriptionDisposers.set([orgId, desc.name], subscriptionDisposers)
      }

      // Register scheduled jobs. A `schedule` registers the handler only: the
      // one scheduler per (app, job) lives on `kernel-cron` and fans out over
      // orgs at each tick (infra/jobs/fanout.ts), so registering an org adds no
      // scheduler.
      if (desc.jobs) {
        for (const [jobName, jobDef] of Object.entries(desc.jobs as Record<string, any>)) {
          if (jobDef.schedule) {
            if (isManifestFormat) {
              // Manifest format: register worker that dispatches to sandbox with a real RPC bridge.
              // The BullMQ worker injects _tx (RLS-scoped) and orgId into the payload.
              const exportName = jobDef.handler
              const appName = desc.name
              const bridgeManifest = manifestForBridge!
              const sandboxHandler = async (payload: any) => {
                const { getWorkerPool, initWorkerPool } = await import(
                  "~/modules/apps/sandbox/worker-pool"
                )
                const source = await loadBundle(bundlePath)
                const jobOrgId: string = payload.orgId ?? orgId
                // SECURITY (defense-in-depth, cross-tenant escalation): the
                // sandbox enqueueJob bridge pins the trusted orgId into the
                // payload, but harden the read side too — refuse to run the
                // sandbox handler with `<app>:*` scopes against an org where
                // this app is not actually installed (no per-org manifest
                // registration). Multi-org safe: checks real per-(org,app)
                // install state rather than the closure's registering org.
                if (!manifestRegistry.has([jobOrgId, appName])) {
                  // Refuse THIS run (the security point), quietly: a fan-out
                  // run for an org whose registration failed (its app is in
                  // `error`) can do nothing, and a retry cannot change that.
                  // Counted; the org's registration is retried at most hourly.
                  const { countJobMetrics } = await import("~/infra/jobs/fanout-keys")
                  await countJobMetrics({ fanout_skip_not_registered: 1 })
                  log.info(
                    { app: appName, job: jobName, orgId: jobOrgId },
                    "scheduled job skipped: the app is not registered for the org",
                  )
                  return
                }
                const actorId: string = payload._userId ?? `system:${appName}:${jobName}`
                const bridge = buildJobBridge(
                  appName,
                  actorId,
                  jobOrgId,
                  payload,
                  bridgeManifest,
                  Array.isArray(payload._callerScopes) ? payload._callerScopes : undefined,
                )
                // Job handlers execute in the OUT-OF-PROCESS worker pool, like
                // manifest event handlers: an in-process QuickJS job (e.g. a mail
                // full-history sync page) stalls the host event loop in multi-
                // second synchronous chunks. Bridge calls come back over IPC and
                // run these same closures, so the injected tx/session and wrappers
                // behave exactly as before. `_tx` / `_session` are host-only
                // handles — the bridge closes over them; never ship them in the
                // worker's params.
                const { _tx, _session, ...sandboxPayload } = payload
                await initWorkerPool()
                const result = await getWorkerPool().execute({
                  bundleSource: source,
                  exportName,
                  params: sandboxPayload,
                  bridge,
                  timeoutMs: jobDef.timeoutMs ?? 60_000,
                  priority: "background",
                  // One app's jobs hold at most half the background workers.
                  backgroundGroup: `job:${appName}`,
                  appId: appName,
                })
                if (desc.webhookHealth?.probe === jobName) {
                  await recordUpstreamProbeResult(appName, jobOrgId, jobName, result)
                }
              }
              registerJobWorker(desc.name, jobName, sandboxHandler, { txMode: jobTxMode(jobDef) })
            } else {
              registerJobWorker(desc.name, jobName, jobDef.handler)
            }
          } else if (jobDef.onDemand) {
            if (isManifestFormat) {
              const exportName = jobDef.handler
              const appName = desc.name
              const bridgeManifest = manifestForBridge!
              const sandboxHandler = async (payload: any) => {
                const { getWorkerPool, initWorkerPool } = await import(
                  "~/modules/apps/sandbox/worker-pool"
                )
                const source = await loadBundle(bundlePath)
                const jobOrgId: string = payload.orgId ?? orgId
                // SECURITY (defense-in-depth, cross-tenant escalation) — see the
                // scheduled-job branch above. Refuse to run an on-demand
                // sandbox handler with `<app>:*` scopes against an org where the
                // app is not installed.
                if (!manifestRegistry.has([jobOrgId, appName])) {
                  throw new Error(
                    `Refusing to run job "${appName}:${jobName}" for org "${jobOrgId}": app not installed for that org`,
                  )
                }
                const actorId: string = payload._userId ?? `system:${appName}:${jobName}`
                const bridge = buildJobBridge(
                  appName,
                  actorId,
                  jobOrgId,
                  payload,
                  bridgeManifest,
                  Array.isArray(payload._callerScopes) ? payload._callerScopes : undefined,
                )
                // Out-of-process worker pool — see the scheduled-job branch.
                // `_tx` / `_session` are host-only handles the bridge closes over;
                // strip them from the params that cross the IPC boundary.
                const { _tx, _session, ...sandboxPayload } = payload
                await initWorkerPool()
                await getWorkerPool().execute({
                  bundleSource: source,
                  exportName,
                  params: sandboxPayload,
                  bridge,
                  timeoutMs: jobDef.timeoutMs ?? 60_000,
                  priority: "background",
                  // One app's jobs hold at most half the background workers.
                  backgroundGroup: `job:${appName}`,
                  appId: appName,
                })
              }
              registerJobWorker(desc.name, jobName, sandboxHandler, { txMode: jobTxMode(jobDef) })
            } else {
              registerJobWorker(desc.name, jobName, jobDef.handler)
            }
          }
        }
      }
      // Register webhooks — manifest format stores handler tuples
      if (desc.webhooks) {
        // Webhook-health contract (validated in contract.ts webhookHealthErrors):
        // the probe job ingest-health judges this app's stream by, or null.
        declareWebhookHealth(
          desc.name,
          orgId,
          typeof desc.webhookHealth?.probe === "string" ? desc.webhookHealth.probe : null,
          typeof desc.webhookHealth?.deliveryGraceSec === "number"
            ? desc.webhookHealth.deliveryGraceSec
            : undefined,
        )
        for (const [name, def] of Object.entries(desc.webhooks as Record<string, any>)) {
          webhookHandlers.set([orgId, desc.name, name], {
            handler: isManifestFormat
              ? { bundlePath, exportName: def.handler, trusted: desc.trusted !== false }
              : def.handler,
            verify: isManifestFormat
              ? { bundlePath, exportName: def.verify, trusted: desc.trusted !== false }
              : def.verify,
            appName: desc.name,
            orgId,
            ...(typeof def.bodyLimitBytes === "number"
              ? { bodyLimitBytes: def.bodyLimitBytes }
              : {}),
            ...(typeof def.timeoutMs === "number" ? { timeoutMs: def.timeoutMs } : {}),
            ...(manifestForBridge ? { _manifest: manifestForBridge } : {}),
            ...(def.requiresUserActor === true ? { requiresUserActor: true } : {}),
          })
        }
      }

      // Register entities
      if (desc.entities) {
        for (const [entityName, entityDef] of Object.entries(
          desc.entities as Record<string, any>,
        )) {
          entityRegistry.set([orgId, desc.name, entityName], entityDef)
          // The same mapping the catalog derivations use (catalog-derivations.ts):
          // a parent in an immutable table carries its retention.
          const fileParent = manifestFileParentOf(desc, entityDef)
          if (fileParent) manifestFileParentRegistry.set([orgId, desc.name, entityName], fileParent)
        }
      }

      // Register top-level attention translations (declarative event-to-attention).
      if ((desc as any).attention?.translations) {
        manifestAttentionRegistry.set([orgId, desc.name], (desc as any).attention.translations)
      }
      // Phase 16 Task A3 — register the manifest's declared `filterableAxes`
      // so the Settings → Attention preferences page (Task A8a) can surface
      // per-app filter chips.
      if ((desc as any).attention?.filterableAxes) {
        manifestAttentionAxesRegistry.set(
          [orgId, desc.name],
          (desc as any).attention.filterableAxes as string[],
        )
      }

      // Register views
      if (desc.views) {
        viewRegistry.set([orgId, desc.name], desc.views)
      }

      // Phase 16 Task A4 / C2 — register manifest-declared external search handler.
      // Wraps the sandboxed bundle export with `makeSandboxSearchHandler` and
      // registers it with `fanoutExternal()` so the global search UI surfaces
      // "From <app>" hits at query time.
      if ((desc as any).search?.handler && isManifestFormat && bundlePath) {
        const searchDef = (desc as any).search as {
          handler: string
          timeoutMs?: number
        }
        const appNameLocal = desc.name
        const bridgeManifest = manifestForBridge!
        const { makeSandboxSearchHandler } = await import("~/modules/search/external-bridge")
        const { registerExternalSearchHandler } = await import("~/modules/search/external-handlers")
        const timeoutMs = searchDef.timeoutMs ?? 5000
        const handler = makeSandboxSearchHandler({
          appName: appNameLocal,
          handlerName: searchDef.handler,
          timeoutMs,
          dispatch: async (handlerName, payload, tenant) => {
            const { executeInSandbox } = await import("~/modules/apps/sandbox/executor")
            const { getSandboxPool } = await import("~/modules/apps/sandbox/pool")
            const { createSessionRpcBridge } = await import("~/modules/apps/sandbox/rpc-bridge")
            const { withPrivilegedDb } = await import("~/db/privileged")
            const { createRlsSession } = await import("~/db/rls")
            const source = await loadBundle(bundlePath)
            // Tenant comes from the host's trusted context (out-of-band of the
            // §4.4 payload) — the sandbox payload no longer carries orgId/userId
            // and could not be trusted for tenant scoping even if it did.
            const searchOrgId = tenant.orgId || orgId
            const userIdForActor = tenant.userId || `system:${appNameLocal}:search`
            // Bridge-owned transactions: the privileged pool connection is
            // acquired per BRIDGE CALL, not held across the whole sandbox run —
            // a slow search handler no longer pins a privileged pool slot.
            // An app the platform does not vouch for gets an RLS session as the
            // app itself instead, and runs in the isolated worker pool.
            const vouched = hasPrivilegedBridge(desc)
            const searchSession = vouched
              ? ({
                  ctx: { actorType: "system", orgId: searchOrgId, purpose: "job" },
                  run: (fn: (tx: any) => Promise<any>) =>
                    withPrivilegedDb(searchOrgId, `search:${appNameLocal}`, fn),
                } as never)
              : createRlsSession({
                  actorType: "system",
                  orgId: searchOrgId,
                  purpose: "job",
                  scopes: [`${appNameLocal}:*`],
                })
            const bridge = createSessionRpcBridge(
              appNameLocal,
              userIdForActor,
              searchOrgId,
              searchSession,
              bridgeManifest,
              [`${appNameLocal}:*`],
            )
            if (!vouched) {
              const { getWorkerPool, initWorkerPool } = await import(
                "~/modules/apps/sandbox/worker-pool"
              )
              await initWorkerPool()
              return (await getWorkerPool().execute({
                bundleSource: source,
                exportName: handlerName,
                params: payload,
                bridge,
                timeoutMs,
                appId: appNameLocal,
              })) as unknown
            }
            return (await executeInSandbox({
              pool: getSandboxPool(),
              bundleSource: source,
              exportName: handlerName,
              params: payload,
              bridge,
              timeoutMs,
            })) as unknown
          },
        })
        registerExternalSearchHandler(orgId, appNameLocal, handler, { timeoutMs })
      }

      // Register slots and contributions: one list, read by `listSlotPanels`.
      registerAppSlots(orgId, desc.name, desc.slots, desc.contributions)
      if (desc.contributions) {
        for (const [slotTarget, contribution] of Object.entries(
          desc.contributions as Record<string, any>,
        )) {
          const existing = contributionRegistry.get([orgId, slotTarget]) ?? []
          existing.push({ app: desc.name, contribution })
          contributionRegistry.set([orgId, slotTarget], existing)
        }
      }

      // Register export handlers. A manifest app with a handler bundle resolves
      // to the sandbox export by name. Bundle-less manifest apps (kernel-owned
      // UI surfaces / source adapters with no app schema, e.g. contacts,
      // google-drive) fall back to a built-in in-process handler keyed by app
      // name; in-process descriptors carry the function directly.
      if (desc.export) {
        const useBundle =
          isManifestFormat && typeof bundlePath === "string" && bundlePath.length > 0
        let handler:
          | { bundlePath: string; exportName: string; trusted: boolean }
          | ((ctx: any, format: string) => Promise<unknown>)
        if (useBundle) {
          handler = {
            bundlePath,
            exportName: desc.export.handler,
            trusted: desc.trusted !== false,
          }
        } else if (isManifestFormat) {
          const builtin = BUILTIN_EXPORT_HANDLERS[desc.name]
          if (!builtin) {
            throw new Error(
              `App "${desc.name}" declares an export but has no handler bundle and no built-in export handler`,
            )
          }
          handler = builtin
        } else {
          handler = desc.export.handler
        }
        exportRegistry.set([orgId, desc.name], {
          formats: desc.export.formats,
          handler,
          schema: desc.export.schema,
          dimensions: desc.export.dimensions,
          ...(useBundle ? { _manifest: manifestForBridge } : {}),
        })
      }

      // Register import kinds (modules/imports). Host handlers of built-in
      // apps are resolved by the runner; an app with a handler bundle runs a
      // kind it has no host handler for through that bundle's export.
      if (desc.import) {
        const declared: { kinds: Record<string, ImportKindDecl> } = desc.import
        // A kind that runs in a bundle (no built-in host handler) writes only
        // its app's own schema: undo deletes what a kind declares.
        const kinds: Record<string, ImportKindDecl> = {}
        for (const [kindName, kindDecl] of Object.entries(declared.kinds)) {
          const errs = importKindRestrictionErrors(desc.name, kindName, kindDecl, {
            builtin: `${desc.name}.${kindName}` in BUILTIN_IMPORT_KINDS,
          })
          if (errs.length > 0) {
            log.error({ app: desc.name, kind: kindName, errors: errs }, "import kind refused")
            continue
          }
          kinds[kindName] = kindDecl
        }
        const decl = { kinds }
        const useBundle =
          isManifestFormat && typeof bundlePath === "string" && bundlePath.length > 0
        importRegistry.set([orgId, desc.name], {
          kinds: decl.kinds,
          ...(useBundle
            ? {
                bundle: { bundlePath, trusted: desc.trusted !== false },
                ...(manifestForBridge ? { _manifest: manifestForBridge } : {}),
              }
            : {}),
        })
      }

      // Register bulk agent tools (grouped) from manifest.bulk declarations.
      if ((desc as any).bulk && desc.tools) {
        const { registerBulkAgentTools } = await import("~/modules/apps/bulk-agent-tools")
        registerBulkAgentTools({
          orgId,
          appName: desc.name,
          bulk: (desc as any).bulk,
          tools: desc.tools as any,
        })
      }

      // Register manifest metadata for the frontend bootstrap endpoint.
      // Entities are projected through an allowlist so server-only fields (tableName,
      // indexFields, permissionFields, fileParent) never reach the web client.
      if (isManifestFormat) {
        const safeEntities = (desc as any).entities
          ? Object.fromEntries(
              Object.entries((desc as any).entities as Record<string, any>).map(([key, e]) => [
                key,
                {
                  labelField: e.labelField,
                  handlePrefix: e.handlePrefix,
                  searchable: e.searchable,
                  cardComponent: e.cardComponent,
                  readScope: e.readScope,
                  discussion: e.discussion,
                },
              ]),
            )
          : undefined
        // Phase 16.5 — installed apps with a UI bundle get a versioned URL the
        // frontend bootstrap dynamic-imports. In-tree apps and installed apps
        // without `ui.js` keep `uiBundleUrl: null`, which falls through to the
        // `trustedAppExports` path in `bootstrap.ts`.
        const uiBundlePath = (desc as any)._uiBundlePath as string | undefined
        manifestRegistry.set([orgId, desc.name], {
          name: desc.name,
          views: (desc as any).views ?? undefined,
          slots: (desc as any).slots ?? undefined,
          contributions: (desc as any).contributions ?? undefined,
          bulk: (desc as any).bulk ?? undefined,
          roles: (desc as any).roles ?? undefined,
          savedViews: (desc as any).savedViews ?? undefined,
          features: (desc as any).features ?? undefined,
          entities: safeEntities,
          tools: projectBulkToolSchemas((desc as any).bulk, desc.tools as any),
          configKeys: desc.configKeys ?? undefined,
          kind: desc.kind === "connector" ? "connector" : "app",
          settings: desc.settings
            ? {
                sections: materialiseSections(appSettingsSchema.parse(desc.settings), {
                  app: desc.name,
                  connections: desc.connections,
                }),
              }
            : undefined,
          description: typeof desc.description === "string" ? desc.description : undefined,
          displayName: typeof desc.displayName === "string" ? desc.displayName : undefined,
          version: desc.version,
          license: typeof desc.license === "string" ? desc.license : undefined,
          author: typeof desc.author === "string" ? desc.author : undefined,
          publisher: listingPublisher(desc),
          homepage: typeof desc.homepage === "string" ? desc.homepage : undefined,
          // Checked by validateAppManifest before the app got here.
          iconSvg: typeof desc.iconSvg === "string" ? desc.iconSvg : undefined,
          iconName: typeof desc.iconName === "string" ? desc.iconName : undefined,
          uiBundleUrl: uiBundlePath ? `/api/apps/${desc.name}/${desc.version}/ui.js` : null,
        })

        // Register connection configs so OAuth + credential routes can validate against manifest
        if ((desc as any).connections) {
          for (const [connName, connDef] of Object.entries(
            (desc as any).connections as Record<string, any>,
          )) {
            connectionConfigRegistry.set([orgId, desc.name, connName], connDef)
            if (bundlePath && typeof connDef?.beforeDisconnect === "string") {
              connectionBeforeDisconnectRegistry.set([orgId, desc.name, connName], {
                bundlePath,
                exportName: connDef.beforeDisconnect,
              })
            }
          }
        }

        if (oauthClientResolvers) {
          for (const [connectionName, resolver] of Object.entries(
            oauthClientResolvers as Record<string, any>,
          )) {
            oauthClientResolverRegistry.set([orgId, desc.name, connectionName], resolver)
          }
        }
      }

      // App-specific RPC bridge methods (e.g. a connector's REST calls). Merged
      // into this app's sandbox bridge by `createRpcBridge` — keeps app logic out
      // of the generic kernel bridge and off any app-name branch.
      if (typeof bridgeExtension === "function") {
        appBridgeExtensionRegistry.set([orgId, desc.name], bridgeExtension)
      }

      // A built-in app's host-side tools (TS descriptor only, never a manifest):
      // registered under the app, so a teardown removes them with the rest and
      // every re-registration brings them back.
      const registerHostTools: ((orgId: string) => void) | undefined = desc._registerHostTools
      if (typeof registerHostTools === "function") registerHostTools(orgId)

      registeredApps.add(registrationKey)
      registeredAppVersions.set(registrationKey, desc.version)
      invalidateScopeCatalog(orgId)
      invalidateDimensionCatalog(orgId)
    } catch (err) {
      // Clean up all in-memory registries on partial registration failure. A
      // version switch instead puts the running version back (below).
      if (!oldVersion) await teardownAppRegistrations(orgId, desc.name)
      throw err
    }
  })()

  appRegistrationPromises.set(registrationKey, registrationPromise)
  try {
    try {
      await registrationPromise
    } catch (err) {
      if (oldVersion) await restoreOldVersion(orgId, desc.name, oldVersion)
      throw err
    }
    if (oldVersion) await pruneOldVersion(orgId, desc.name, oldVersion)
    return true
  } finally {
    if (oldVersion) closeRegistryJournal(oldVersion.journal)
    appRegistrationPromises.delete(registrationKey)
  }
}

/**
 * Every registry keyed `[orgId, appName, ...]` that a registration fills. The
 * teardown empties them; a version switch (`registerSingleApp` with `swap`)
 * registers over them and then prunes the keys the new version did not write.
 * A registration that learns a new registry adds it here, or a reinstall stacks
 * stale entries and a switch keeps the old version's.
 */
const APP_KEYED_REGISTRIES = [
  toolRegistry,
  approvalSummarizerRegistry,
  approvalEditableFieldsRegistry,
  approvalExpiryRegistry,
  approvalDedupeKeyRegistry,
  approvalDedupeSameRequesterRegistry,
  approvalResourceOwnerRegistry,
  skillRegistry,
  routineTemplateRegistry,
  appPromptRegistry,
  agentInstructionsRegistry,
  webhookHandlers,
  entityRegistry,
  manifestFileParentRegistry,
  manifestAttentionRegistry,
  manifestAttentionAxesRegistry,
  dimensionDefRegistry,
  timelineDeclarations,
  manifestRegistry,
  appBridgeManifestRegistry,
  connectionConfigRegistry,
  connectionBeforeDisconnectRegistry,
  oauthClientResolverRegistry,
  appBridgeExtensionRegistry,
  appDependenciesRegistry,
  appCrossAppCallsRegistry,
  appContractImplementationsRegistry,
  appContractCallsRegistry,
  appSettingsRegistry,
  attentionItemsRegistry,
  appCapabilitiesRegistry,
  viewRegistry,
  slotRegistry,
  exportRegistry,
  importRegistry,
]

/**
 * Tear down every in-memory registry entry, event subscription, and external
 * search handler that `registerSingleApp` populated for `(orgId, appName)`.
 * Used by BOTH the registration-rollback path (partial failure) and the
 * uninstall path (via `unregisterAppEverywhere`). Keeping the two in lockstep
 * is the whole point — if registration learns to populate a new registry, it
 * must be torn down here too, or a reinstall stacks stale handlers.
 *
 * Idempotent: deleting a missing key is a no-op, and subscription disposers
 * guard against double-dispose.
 */
export async function teardownAppRegistrations(orgId: string, appName: string): Promise<void> {
  // Dispose event subscriptions first (removes channel handlers + Redis subs).
  const disposers = eventSubscriptionDisposers.get([orgId, appName])
  if (disposers) {
    for (const dispose of disposers) {
      try {
        await dispose()
      } catch (err) {
        log.warn({ err, app: appName, orgId }, "Event subscription disposer failed")
      }
    }
    eventSubscriptionDisposers.delete([orgId, appName])
  }

  for (const registry of APP_KEYED_REGISTRIES) registry.deleteByPrefix([orgId, appName])
  invalidateScopeCatalog(orgId)
  invalidateDimensionCatalog(orgId)
  forgetWebhookHealth(appName, orgId)
  deleteDeclaredEmits(orgId, appName)
  // Unregister any external-search handler we registered (org-scoped — only
  // this org's registration, not other tenants').
  {
    const { unregisterExternalSearchHandler } = await import("~/modules/search/external-handlers")
    unregisterExternalSearchHandler(orgId, appName)
  }
  // contributionRegistry is keyed by [orgId, slotTarget] (NOT appName), and a
  // single slot can hold contributions from multiple apps. Filter out only the
  // entries this app contributed; drop the key when it becomes empty.
  for (const [key, entries] of contributionRegistry.entriesOf(orgId)) {
    if (key[0] !== orgId) continue
    const remaining = entries.filter((e: { app: string }) => e.app !== appName)
    if (remaining.length === entries.length) continue
    if (remaining.length === 0) contributionRegistry.delete(key)
    else contributionRegistry.set(key, remaining)
  }
  // DB-side pause of the app's instantiated routines (sourceKind='app') —
  // distinct from the in-memory registry sweep above. Disposes their event
  // subscriptions so no orphan event runs survive the uninstall (Task A12 / H6).
  await pauseAppRoutinesForOrg(orgId, appName)
  registeredApps.delete(`${orgId}:${appName}`)
  registeredAppVersions.delete(`${orgId}:${appName}`)
}

/**
 * Uninstall-time teardown: remove the app's in-memory registrations across
 * EVERY org it was registered in. The install/uninstall surface is
 * org-agnostic (an app is installed platform-wide), but the runtime registers
 * it per-org, so we sweep `registeredApps` for matching keys and tear each
 * down. Also clears the cross-org search handlers and the `*:appName`
 * declaredEmits / kernel-scoped attention provider entries.
 */
export async function unregisterAppEverywhere(appName: string): Promise<void> {
  // Snapshot the orgs this app is registered in (keys are `${orgId}:${appName}`).
  const orgIds = new Set<string>()
  for (const key of registeredApps) {
    // Keys are `${orgId}:${appName}`. orgIds are UUIDs (no colons), so a
    // suffix match on `:${appName}` uniquely identifies this app's keys.
    const suffix = `:${appName}`
    if (key.endsWith(suffix)) {
      orgIds.add(key.slice(0, -suffix.length))
    }
  }
  for (const orgId of orgIds) {
    await teardownAppRegistrations(orgId, appName)
  }
  // Sweep any external-search handlers registered under orgs that weren't in
  // `registeredApps` (defense-in-depth), and kernel-scoped ("*") entries.
  {
    const { unregisterExternalSearchHandlersForApp } = await import(
      "~/modules/search/external-handlers"
    )
    unregisterExternalSearchHandlersForApp(appName)
  }
  deleteDeclaredEmits("*", appName)
  attentionItemsRegistry.delete(["*", appName])
  // Job handlers are process-wide, not per org: an uninstalled app's jobs must
  // not stay callable.
  unregisterAppJobHandlers(appName)
}

/**
 * Register a kernel-scoped (cross-org) attention provider.
 * The aggregator iterates all entries; entries with orgId "*" match every org and are
 * called as trusted in-process functions instead of via the sandbox executor.
 */
export function registerKernelAttentionProvider(opts: {
  handler: string
  scope?: string
  bundlePath: string
  /** Optional logical app key used to identify this provider in the registry.
   *  Kernel ships multiple providers (approvals, attention_events) — each must
   *  register under a distinct key so the aggregator invokes them independently. */
  appName?: string
}): void {
  const appName = opts.appName ?? "kernel"
  attentionItemsRegistry.set(["*", appName], {
    handler: opts.handler,
    scope: opts.scope,
    bundlePath: opts.bundlePath,
    trusted: true,
  })
}

/** The store listing's publisher, when the manifest carries a listing. */
function listingPublisher(desc: object): string | undefined {
  const listing = "listing" in desc ? desc.listing : undefined
  if (!listing || typeof listing !== "object" || !("publisher" in listing)) return undefined
  return typeof listing.publisher === "string" ? listing.publisher : undefined
}
