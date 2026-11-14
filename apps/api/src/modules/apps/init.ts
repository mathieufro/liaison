// SPDX-License-Identifier: FSL-1.1-ALv2
import type { PrivilegedDb } from "~/db"
import { memoryRegistrationConcurrency } from "~/db/pool-plan"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import {
  initializedOrgRuntimes,
  orgRuntimeInitPromises,
  orgRuntimeLastTouch,
  orgRuntimeReleases,
  orgsKnownMissing,
  rememberMissingOrg,
} from "~/modules/apps/app-registries"
import {
  bumpCatalogGeneration,
  catalogGeneration,
  onCatalogGenerationBump,
} from "~/modules/apps/catalog-generation"
import {
  type OrgRegistrationDeps,
  OrgRegistrationQueue,
  type SerializePersistent,
} from "~/modules/apps/registration-lane"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { initSandboxPool } from "~/modules/apps/sandbox/pool"
import { installedAppsOwningTheirRoutes } from "~/modules/apps/tab-route-ownership"

export interface InitAppsForOrgOptions {
  /** Extra app descriptors for testing (e.g., test-missing-required, test-optional-dep) */
  extraApps?: AppDescriptor[]
  /**
   * The org's setup stamp matched: register without writing the org's
   * persistent app rows (`registerApps` `skipOrgRows`).
   */
  skipOrgRows?: boolean
  /** The serial lane for the transactions that may change an app schema (`registerApps` `serializeDdl`). */
  serializeDdl?: SerializePersistent
}

import { readFileSync } from "node:fs"
import { dirname } from "node:path"

// Re-read the JSON manifest from disk and re-attach the descriptor's TS-only
// metadata (functions, Zod schemas, runtime defaults) from the cached import.
// This bypasses the module-cache poisoning where some test mutates
// `manifest.schema.<entity>.fields.<f>` and the corruption then propagates
// through every subsequent registerApps call.
//
// The "carry" set covers everything the descriptor adds on top of the JSON:
// `_format`, `_bundlePath`, `_oauthClientResolvers`, and `orgSettings`
// (TS-built defaults consumed by the
// runtime's auto-seed for `organizations.settings.<app>`). Any future
// descriptor-only field needs to be added here, or the runtime's
// orgDefaults seeding won't apply on registration.
const CARRY_KEYS = new Set(["orgSettings"])

/** Returns true if `v` is, or recursively contains, a function. The
 * fresh-manifest reload throws away anything that can't round-trip
 * through JSON, so descriptor keys that bury lazy loaders inside
 * nested objects (e.g. `skills: { name: { body: () => ... } }`) must be
 * carried verbatim from the TS descriptor — otherwise the
 * runtime-registered skill set loses the TS-only entries. */
function containsFunction(v: unknown): boolean {
  if (typeof v === "function") return true
  if (v === null || typeof v !== "object") return false
  if (Array.isArray(v)) return v.some(containsFunction)
  return Object.values(v as Record<string, unknown>).some(containsFunction)
}

/** The descriptor's TS-only keys, carried verbatim onto every fresh copy. */
function carryKeysOf(m: Record<string, unknown>): Record<string, unknown> {
  const carry: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(m)) {
    if (k.startsWith("_") || typeof v === "function" || CARRY_KEYS.has(k) || containsFunction(v)) {
      carry[k] = v
    }
  }
  return carry
}

/** Every manifest JSON read of the catalog goes through here (counted for tests). */
function readManifestJson(jsonPath: string): Record<string, unknown> {
  catalogCacheStats.manifestReads++
  return JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>
}

import {
  type DiscoveredApp,
  discoverInstalledApps,
  discoverInTreeApps,
} from "~/modules/apps/discover-apps"

/**
 * Pick the app descriptor export from a `manifest-descriptor.ts` module. The
 * descriptor is the object carrying `_format: "manifest"` and a `name` matching
 * the app dir. This is more robust than guessing the export name — bundled apps
 * vary between `<name>AppManifest` and `<name>Manifest` conventions.
 */
function pickDescriptorExport(
  mod: Record<string, unknown>,
  appName: string,
): Record<string, unknown> | undefined {
  for (const value of Object.values(mod)) {
    if (
      value &&
      typeof value === "object" &&
      (value as Record<string, unknown>)._format === "manifest" &&
      (value as Record<string, unknown>).name === appName
    ) {
      return value as Record<string, unknown>
    }
  }
  return undefined
}

/**
 * Build an `AppDescriptor` for an installed (`.liaisonapp`) app directly from
 * its JSON manifest. Installed apps cannot carry TS-only descriptor metadata
 * (`_oauthClientResolvers`, `orgSettings`) because the `.liaisonapp` tarball ships no descriptor module —
 * only `app.manifest.json` + `bundle.js`. The install service and freeze tool
 * reject manifests that depend on those features; this loader asserts their
 * absence at registration time as a belt-and-suspenders guard.
 */
const TS_ONLY_MANIFEST_FIELDS = ["_oauthClientResolvers", "orgSettings"] as const

export function installedAppDescriptor(
  app: DiscoveredApp,
  opts: {
    firstParty?: boolean
    publisherSigned?: boolean
    /** The capabilities the admin granted; null/undefined = grandfathered (all declared). */
    grantedCapabilities?: string[] | null
    /** The cross_app_calls targets the admin approved; null/undefined = grandfathered. */
    grantedCrossAppCalls?: string[] | null
  } = {},
): AppDescriptor {
  const manifest = JSON.parse(readFileSync(app.manifestPath, "utf8")) as Record<string, unknown>
  for (const field of TS_ONLY_MANIFEST_FIELDS) {
    if (field in manifest) {
      throw new Error(
        `Installed app '${app.name}' manifest declares '${field}' — TS-only descriptor metadata is not permitted in installed apps`,
      )
    }
  }
  // Capabilities are part of the admin's grant: the bridge's `requireCapability` reads
  // the descriptor's `capabilities`, so an installed app sees only the declared
  // capabilities the admin granted (a first-party artifact carries all of its own).
  const declaredCaps = Array.isArray(manifest.capabilities)
    ? (manifest.capabilities as string[])
    : []
  const effectiveCaps =
    opts.firstParty === true || !opts.grantedCapabilities
      ? declaredCaps
      : declaredCaps.filter((c) => opts.grantedCapabilities?.includes(c))
  // Same for cross_app_calls: a declared target authorizes app-to-app dispatch without
  // the caller's scopes, so only the targets the admin approved are kept.
  const declaredCalls = Array.isArray(manifest.cross_app_calls)
    ? (manifest.cross_app_calls as Array<{ target?: unknown }>)
    : []
  const effectiveCalls =
    opts.firstParty === true || !opts.grantedCrossAppCalls
      ? declaredCalls
      : declaredCalls.filter(
          (c) => typeof c.target === "string" && opts.grantedCrossAppCalls?.includes(c.target),
        )
  // `dependencies.tools` also authorizes dispatch (to an internal tool marked
  // deferLoading), so it is narrowed to the approved targets the same way.
  const deps = manifest.dependencies as { tools?: unknown } | undefined
  const narrowedDeps =
    deps && Array.isArray(deps.tools) && opts.firstParty !== true && opts.grantedCrossAppCalls
      ? {
          dependencies: {
            ...deps,
            tools: (deps.tools as unknown[]).filter(
              (t) => typeof t === "string" && opts.grantedCrossAppCalls?.includes(t),
            ),
          },
        }
      : {}
  // An older package may still carry `trusted` (the package schema refuses it
  // since): dropped, it decides nothing. Where an app runs is the platform's
  // call (core/registry.ts), and an installed app is never core.
  delete manifest.trusted
  return {
    ...manifest,
    ...(declaredCaps.length > 0 ? { capabilities: effectiveCaps } : {}),
    ...(declaredCalls.length > 0 ? { cross_app_calls: effectiveCalls } : {}),
    ...narrowedDeps,
    // Marks a descriptor that came from a runtime install (as opposed to the image's
    // in-tree apps), so runtime.ts can hold it to the third-party rules (no
    // unvouched DB triggers). Set after the spread: a manifest cannot unset it.
    _installed: true,
    // First-party is the platform's voucher (getDefaultApps matches the installed
    // artifact against the image's own catalog tarball), never the manifest's: it
    // is always set here, after the spread, so a manifest cannot claim it. It only
    // lets runtime.ts honour the app's declarations (`readOnly` and its kin,
    // triggers); the app stays sandboxed, on an RLS bridge, like any other.
    _firstParty: opts.firstParty === true,
    // The OPERATOR's own voucher, and like `_firstParty` set here, after the spread,
    // so a manifest can never claim it: this install's artifact carried a cosign
    // bundle that `verifyAppPackage` verified against the configured
    // `LIAISON_TRUSTED_APP_PUBLISHERS` identity (a `.*` wildcard is refused), so the
    // org chose this publisher before the bytes ever ran. It only lets runtime.ts
    // honour `readOnly`; the app stays sandboxed and unsigned installs get nothing.
    _publisherSigned: opts.publisherSigned === true,
    _format: "manifest",
    _bundlePath: app.bundlePath,
    ...(app.uiBundlePath ? { _uiBundlePath: app.uiBundlePath } : {}),
  } as unknown as AppDescriptor
}

/**
 * The installed apps to register: the active version of each
 * (`kernel.apps_active_version`). The install root also keeps each app's previous
 * version, for a switch-back or a rollback; it is never registered. A directory
 * with no active version (an uninstall in progress) registers nothing.
 */
export async function activeInstalledApps(): Promise<DiscoveredApp[]> {
  return (await readActiveInstalledApps()).apps
}

/**
 * `activeInstalledApps`, saying whether the answer is a fallback (`degraded`):
 * the catalog cache never keeps a catalog built from one (`getDefaultApps`).
 */
async function readActiveInstalledApps(): Promise<{ apps: DiscoveredApp[]; degraded: boolean }> {
  const all = await discoverInstalledApps()
  if (all.length === 0) return { apps: all, degraded: false }
  try {
    const { activeVersionRows } = await import("~/modules/apps/activation")
    const rows = await catalogDbRead("apps-active-versions", (db) => activeVersionRows(db))
    const { versionForThisRelease } = await import("~/modules/apps/catalog")
    // An old process during a rolling deploy registers the version its own
    // catalog carries when a newer release's catalog installed the active one
    // (catalog.ts).
    const active = new Map(
      rows.map((r) => [r.name, versionForThisRelease(r.name, r.version, r.sourceUrl)]),
    )
    return { apps: all.filter((app) => active.get(app.name) === app.version), degraded: false }
  } catch (err) {
    // Without the active versions, register the newest version of each app
    // rather than none: an outage of every installed app is worse.
    log.error({ err }, "Reading the active app versions failed: registering the newest of each")
    const { isNewerVersion } = await import("~/modules/apps/activation")
    const newest = new Map<string, DiscoveredApp>()
    for (const app of all) {
      const seen = newest.get(app.name)
      if (!seen || isNewerVersion(app.version, seen.version)) newest.set(app.name, app)
    }
    return { apps: [...newest.values()], degraded: true }
  }
}

/** Test seam: makes the catalog's database reads fail (a database blip). */
const catalogDbFault = { failing: false }

/** A catalog read on the system pool (`withSystemDb`), failing on demand in tests. */
async function catalogDbRead<T>(reason: string, fn: (db: PrivilegedDb) => Promise<T>): Promise<T> {
  if (catalogDbFault.failing) throw new Error("catalog database read failed (test fault)")
  const { withSystemDb } = await import("~/db/privileged")
  return withSystemDb(reason, fn)
}

/**
 * One catalog app as cached per catalog generation: its JSON part (the parsed
 * manifest, or an installed app's whole descriptor) and the descriptor keys that
 * cannot round-trip through JSON. Every `getDefaultApps` call clones `json`, so a
 * registration that mutates its descriptor never reaches another call's copy
 * (the guarantee `freshManifest` gave by re-reading the file each time).
 */
type CachedCatalogApp =
  | { kind: "in-tree"; json: Record<string, unknown>; carry: Record<string, unknown> }
  | { kind: "installed"; descriptor: AppDescriptor }

const catalogCacheStats = { manifestReads: 0, voucherRuns: 0, builds: 0 }
let catalogCache: { generation: number; apps: Promise<CatalogBuild> } | null = null
onCatalogGenerationBump(() => {
  catalogCache = null
})

/**
 * The apps this process registers for an org. The expensive inputs (descriptor
 * modules, manifest files, active-version rows, install vouchers) are read once
 * per catalog generation (`catalog-generation.ts`): an org's first-touch setup
 * reads no file while the catalog is unchanged. Each call returns fresh copies.
 */
export async function getDefaultApps(): Promise<AppDescriptor[]> {
  const generation = catalogGeneration()
  if (catalogCache?.generation !== generation) {
    const apps = buildCatalogApps()
    catalogCache = { generation, apps }
    // A failed read is not remembered: the next call reads again. Neither is a
    // catalog built from a fallback (the newest version of each installed app
    // in place of the active one, no capability grants): it serves this call,
    // and the next one reads again rather than keep it for the generation.
    apps.then(
      (build) => {
        if (build.degraded && catalogCache?.apps === apps) catalogCache = null
      },
      () => {
        if (catalogCache?.apps === apps) catalogCache = null
      },
    )
  }
  const { apps: cached } = await catalogCache.apps
  return cached.map((app) =>
    app.kind === "installed"
      ? structuredClone(app.descriptor)
      : ({ ...structuredClone(app.json), ...app.carry } as unknown as AppDescriptor),
  )
}

/** One catalog build; `degraded` when an input came from a fallback after a failed read. */
interface CatalogBuild {
  apps: CachedCatalogApp[]
  degraded: boolean
}

async function buildCatalogApps(): Promise<CatalogBuild> {
  catalogCacheStats.builds++
  const inTree = await discoverInTreeApps()
  const apps: CachedCatalogApp[] = []
  const bundledNames = new Set<string>()

  for (const app of inTree) {
    if (!app.descriptorPath) continue
    const mod = (await import(app.descriptorPath)) as Record<string, unknown>
    const descriptor = pickDescriptorExport(mod, app.name)
    if (!descriptor) {
      throw new Error(
        `App '${app.name}' descriptor '${app.descriptorPath}' must export a manifest descriptor (_format: "manifest", name: "${app.name}")`,
      )
    }
    // In-tree apps ship in the image source tree, so they are first-party by
    // construction (core or not: being first-party vouches for declarations, it
    // never makes an app core).
    apps.push({
      kind: "in-tree",
      json: readManifestJson(app.manifestPath),
      carry: { ...carryKeysOf(descriptor), _firstParty: true },
    })
    bundledNames.add(app.name)
  }

  // Installed apps from the runtime install root. Bundled apps win on name
  // conflict: a same-named installed app is dropped (the install service
  // refuses such installs in the first place — this branch only fires if a
  // platform upgrade later added a bundled app shadowing a prior install).
  // An installed app whose tab pattern is not its own (another app's prefix, a Liaison page,
  // a leading parameter) would take that page's deep links: it is left out.
  const active = await readActiveInstalledApps()
  const installed = installedAppsOwningTheirRoutes(inTree, active.apps)
  const { firstParty, publisherSigned, grantedCapabilities, grantedCrossAppCalls, degraded } =
    await vouchedInstalls(installed)
  for (const app of installed) {
    if (bundledNames.has(app.name)) {
      log.warn(
        { app: app.name },
        "Installed app shadowed by a bundled app of the same name — skipping installed version",
      )
      continue
    }
    const descriptor = installedAppDescriptor(app, {
      firstParty: firstParty.has(`${app.name}@${app.version}`),
      publisherSigned: publisherSigned.has(`${app.name}@${app.version}`),
      grantedCapabilities: grantedCapabilities.get(`${app.name}@${app.version}`) ?? null,
      grantedCrossAppCalls: grantedCrossAppCalls.get(`${app.name}@${app.version}`) ?? null,
    })
    apps.push({ kind: "installed", descriptor })
  }

  return { apps, degraded: active.degraded || degraded }
}

/** Test seam: the catalog cache's read counters, and a reset. */
export const GetDefaultAppsTestAccess = {
  stats: (): Readonly<typeof catalogCacheStats> => ({ ...catalogCacheStats }),
  resetStats(): void {
    catalogCacheStats.manifestReads = 0
    catalogCacheStats.voucherRuns = 0
    catalogCacheStats.builds = 0
  },
  /** Make the catalog's database reads (active versions, install rows) fail, or work again. */
  failCatalogDbReads(failing: boolean): void {
    catalogDbFault.failing = failing
  },
}

/**
 * The two vouchers that let runtime.ts honour a sandboxed install's `readOnly`
 * self-declaration, each keyed `name@version`.
 *
 * `firstParty`: the PLATFORM vouches. The install's artifact is the image's own
 * catalog tarball (its `apps_installed` sha256 matches it) AND its install dir,
 * every file the runtime loads from it, is byte-identical to that tarball's
 * contents. The row alone is not enough: an install that fails after copying its
 * files leaves other bytes on disk under the old row, and a genuine manifest says
 * nothing about the handlers beside it. A sideloaded app, or one whose bytes
 * differ from the baked tarball, is not in the set.
 *
 * `publisherSigned`: the OPERATOR vouches, at install time. The row carries a
 * `signature_bundle`, which `install-service` persists only from a `verifyAppPackage`
 * result — and that field is set ONLY after `cosign verify-blob` succeeded against
 * this instance's configured `LIAISON_TRUSTED_APP_PUBLISHERS` certificate identity,
 * which may not be empty or a `.*` wildcard. So membership means the operator named
 * a publisher and these exact bytes carry that publisher's signature. An unsigned
 * install — every sideload the org did not vouch for, `requireSignature: false`
 * included — is never in the set, and neither voucher changes the app's tier: it
 * still runs sandboxed.
 *
 * Each install dir is hashed once per discovery. Fails closed: on any error neither
 * set is populated, so `readOnly` stays ignored.
 */
/**
 * One installed app's descriptor, exactly as `getDefaultApps` builds it for
 * registration, without registering anything: the version this process
 * registers (the active one in `kernel.apps_active_version`, or this release's
 * catalog version when the active one is newer) found in the install root, vouched the same
 * way. `null` when the app has no active version on disk, or when an in-tree
 * app has the name (it wins at registration). The CLI resolves an installed
 * app's import kind through this, since it never registers apps.
 */
export async function readInstalledAppDescriptor(
  name: string,
  /** A version other than the active one: the candidate an activation judges. */
  version?: string,
): Promise<AppDescriptor | null> {
  const { withSystemDb } = await import("~/db/privileged")
  const { activeVersionRows } = await import("~/modules/apps/activation")
  const [active] = version
    ? [{ name, version, sourceUrl: null }]
    : await withSystemDb("apps-active-version", (db) => activeVersionRows(db, name))
  if (!active) return null
  if ((await discoverInTreeApps()).some((a) => a.name === name)) return null
  // Without an explicit candidate: the version this process registers, the same
  // rule as activeInstalledApps (an old process keeps its own catalog's version).
  const { versionForThisRelease } = await import("~/modules/apps/catalog")
  const wanted = version ?? versionForThisRelease(name, active.version, active.sourceUrl)
  const app = (await discoverInstalledApps()).find((a) => a.name === name && a.version === wanted)
  if (!app) return null
  const { firstParty, publisherSigned, grantedCapabilities, grantedCrossAppCalls } =
    await vouchedInstalls([app])
  const id = `${app.name}@${app.version}`
  return installedAppDescriptor(app, {
    firstParty: firstParty.has(id),
    publisherSigned: publisherSigned.has(id),
    grantedCapabilities: grantedCapabilities.get(id) ?? null,
    grantedCrossAppCalls: grantedCrossAppCalls.get(id) ?? null,
  })
}

async function vouchedInstalls(installed: DiscoveredApp[]): Promise<{
  firstParty: Set<string>
  publisherSigned: Set<string>
  grantedCapabilities: Map<string, string[] | null>
  grantedCrossAppCalls: Map<string, string[] | null>
  /** The install rows could not be read: every voucher and grant is the fail-closed default. */
  degraded: boolean
}> {
  catalogCacheStats.voucherRuns++
  const out = new Set<string>()
  const signed = new Set<string>()
  const caps = new Map<string, string[] | null>()
  const calls = new Map<string, string[] | null>()
  if (installed.length === 0) {
    return {
      firstParty: out,
      publisherSigned: signed,
      grantedCapabilities: caps,
      grantedCrossAppCalls: calls,
      degraded: false,
    }
  }
  let degraded = false
  try {
    const { isCatalogArtifact, isCatalogInstall } = await import("~/modules/apps/catalog")
    const { appsInstalled } = await import("~/db/schema/kernel/apps-installed")
    const rows = await catalogDbRead("apps-first-party", (db) =>
      db
        .select({
          name: appsInstalled.name,
          version: appsInstalled.version,
          sha256: appsInstalled.sha256,
          signatureBundle: appsInstalled.signatureBundle,
          grantedCapabilities: appsInstalled.grantedCapabilities,
          grantedCrossAppCalls: appsInstalled.grantedCrossAppCalls,
        })
        .from(appsInstalled),
    )
    for (const app of installed) {
      const row = rows.find((r) => r.name === app.name && r.version === app.version)
      if (!row) {
        // No grant record at all: grant no capabilities (fail closed).
        caps.set(`${app.name}@${app.version}`, [])
        calls.set(`${app.name}@${app.version}`, [])
        continue
      }
      if (
        isCatalogArtifact(app.name, app.version, row.sha256) &&
        isCatalogInstall(app.name, app.version, dirname(app.manifestPath))
      ) {
        out.add(`${app.name}@${app.version}`)
      }
      if (row.signatureBundle) {
        signed.add(`${app.name}@${app.version}`)
      }
      caps.set(`${app.name}@${app.version}`, row.grantedCapabilities ?? null)
      calls.set(`${app.name}@${app.version}`, row.grantedCrossAppCalls ?? null)
    }
  } catch (err) {
    log.warn({ err }, "Install trust check failed: installed apps' readOnly stays ignored")
    degraded = true
    // Capabilities fail closed too: with no grant record readable, grant none.
    for (const app of installed) {
      caps.set(`${app.name}@${app.version}`, [])
      calls.set(`${app.name}@${app.version}`, [])
    }
  }
  return {
    firstParty: out,
    publisherSigned: signed,
    grantedCapabilities: caps,
    grantedCrossAppCalls: calls,
    degraded,
  }
}

/**
 * Shared initialization logic for production and E2E servers.
 * Registers apps and kernel timeline declarations for an org.
 */
export async function initAppsForOrg(
  orgId: string,
  apps: AppDescriptor[],
  opts?: InitAppsForOrgOptions,
): Promise<{ failedApps: string[] }> {
  const { registerApps, registerKernelAttentionProvider } = await import("~/modules/apps/runtime")
  const { registerKernelTimelineDeclarations } = await import("~/modules/audit/timeline")
  const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
  const { registerKernelBulkApp } = await import("~/modules/apps/kernel-bulk")
  const { setDeclaredEmits } = await import("~/modules/apps/app-registries")
  const { KERNEL_DECLARED_EMITS } = await import("~/infra/events/event-bus")

  // Ensure sandbox pool is initialized (idempotent — noop if already running)
  await initSandboxPool(sandboxPoolOptionsForProcess())

  // Register the FULL kernel emit set under "*:kernel" so cross-app
  // subscriptions AND kind:'event' routine validation (validateRoutineEvent /
  // list_routine_events) see every kernel event, not a partial hand-maintained
  // slice. Uses the SAME authoritative list as initEventBus — a per-org runtime
  // init that runs without initEventBus (some tests) still gets the complete
  // catalog. Previously this hardcoded only 4 events, so a routine on
  // kernel:contact:create (and every other kernel event) was rejected as
  // "No in-tree event exists".
  setDeclaredEmits("*", "kernel", new Set(KERNEL_DECLARED_EMITS))

  // Tests reset registries between files; re-register kernel providers with each
  // org runtime init so cached app.ts module initialization is not the only source.
  registerKernelAttentionProvider({
    handler: "computeApprovalAttentionItems",
    scope: "kernel:approvals:read",
    bundlePath: new URL("../approvals/attention.ts", import.meta.url).pathname,
  })
  // "While you were away": decisions taken for the person while they were away, once back.
  registerKernelAttentionProvider({
    appName: "kernel.away_recap",
    handler: "getAwayRecapAttentionItems",
    bundlePath: new URL("../approvals/away-recap.ts", import.meta.url).pathname,
  })
  registerKernelAttentionProvider({
    appName: "kernel.attention_events",
    handler: "getEventAttentionItems",
    bundlePath: new URL("../attention/event-provider.ts", import.meta.url).pathname,
  })
  registerKernelAttentionProvider({
    appName: "kernel.connection_health",
    handler: "computeConnectionHealthAttentionItems",
    scope: "kernel:apps:admin",
    bundlePath: new URL("./connections/attention.ts", import.meta.url).pathname,
  })
  registerKernelAttentionProvider({
    appName: "kernel.mailbox_enrollment",
    handler: "computeMailboxEnrollmentAttentionItems",
    bundlePath: new URL("../mailbox-keys/attention.ts", import.meta.url).pathname,
  })
  registerKernelAttentionProvider({
    appName: "kernel.cloud_billing",
    handler: "computeCloudBillingAttentionItems",
    scope: "kernel:org:admin",
    bundlePath: new URL("../cloud/attention.ts", import.meta.url).pathname,
  })

  const allApps = [...apps, ...(opts?.extraApps ?? [])]
  const { failedApps } = await registerApps(allApps, orgId, {
    skipOrgRows: opts?.skipOrgRows,
    serializeDdl: opts?.serializeDdl,
  })
  registerKernelTimelineDeclarations(orgId)
  await registerKernelAgentTools(orgId)
  registerKernelBulkApp(orgId)
  // Before the org counts as registered: a concurrent first touch that sees it
  // registered must find its MCP tools projected too.
  await setUpOrgInMemoryExtras(orgId)
  initializedOrgRuntimes.add(orgId)
  // One more org set up: past the cap, the least recently used idle ones go.
  const cap = env.LIAISON_ORG_RUNTIME_MAX_ORGS
  if (cap > 0 && initializedOrgRuntimes.size > cap) {
    void import("~/modules/apps/org-runtime-release")
      .then((m) => m.enforceOrgRuntimeCap(cap))
      .catch((err: unknown) => log.warn({ err }, "org runtime cap enforcement failed"))
  }
  // No search settings work here: the settings cover the whole catalog (the
  // setup step applies them), whichever orgs register.

  // NOTE: automatic recovery of a lost connect event is handled per-app on the
  // READ path (e.g. Shopify's ensureInstallMetadata) plus operator-triggered
  // reconcile (Settings "Repair connection" / scripts/reconcile-connection.ts /
  // POST /connections/:id/reconcile). We deliberately do NOT re-drive every
  // active connection on boot: several apps' `onConnectionEstablished` hold a
  // privileged DB transaction across slow external provider calls (webhook
  // registration), so re-firing all of them at once is a thundering herd that
  // exhausts the privileged pool. Recovery stays on the read path (cheap, no
  // external I/O) and on explicit, one-at-a-time operator reconcile.
  return { failedApps }
}

/**
 * The first-party Google login provider from `GOOGLE_OAUTH_*`, reconciled on
 * every setup of the org in a process whatever its stamp (as the boot hook
 * did): a rotated client secret, or a provider row an admin deleted or edited,
 * is restored at the org's next first touch. Best effort; idempotent, and it
 * writes only when the stored provider differs.
 */
async function reconcileGoogleLogin(orgId: string): Promise<void> {
  const { ensureGoogleLoginProvider } = await import("~/modules/auth/google-login-provider")
  try {
    await ensureGoogleLoginProvider(orgId)
  } catch (err) {
    log.error({ err, orgId }, "Google login provider reconcile failed")
  }
}

/**
 * The org's setup work that follows a registration with a stale stamp: the
 * manifest-declared default saved views. Idempotent.
 */
async function runOrgSetupHooks(orgId: string): Promise<void> {
  const { runBackfillForOrg } = await import("~/modules/saved-views/backfill")
  await runBackfillForOrg(orgId)
}

/**
 * The org's MCP connections, projected in this process (mcp-client
 * `ensureMcpOrg`). Never fails the org's setup: its tools wait for a dial.
 */
async function projectOrgMcpConnections(orgId: string): Promise<void> {
  try {
    const { ensureMcpOrg } = await import("~/modules/mcp-client")
    await ensureMcpOrg(orgId)
  } catch (err) {
    log.error({ err, orgId }, "Projecting the org's MCP connections failed")
  }
}

/** Test seam: what `setUpOrg` runs after a registration with a stale stamp. */
export const orgSetupHookSeam: {
  runSetupHooks: (orgId: string) => Promise<void>
  runInMemoryExtras: (orgId: string) => Promise<void>
} = { runSetupHooks: runOrgSetupHooks, runInMemoryExtras: projectOrgMcpConnections }

export interface SetUpOrgOptions
  extends Omit<InitAppsForOrgOptions, "skipOrgRows" | "serializeDdl"> {
  /** Test seam: the app descriptors to register in place of `getDefaultApps()`. */
  apps?: AppDescriptor[]
}

/**
 * Register the org's apps, writing its persistent rows only when its setup
 * stamp is stale (S4). A matching stamp (same build and app versions, no app
 * in error, every app row current) registers in memory only. A stale one is
 * re-read under the org's `org-setup` lock (another process may just have set the
 * org up), then the registration writes, the setup hooks run, and the org is
 * stamped when every app registered. The Google login provider is reconciled
 * either way. With a lane (`serialize`), only the registration transactions
 * that may change an app schema run in it; the rest runs beside other orgs'.
 */
export async function setUpOrg(
  orgId: string,
  opts: SetUpOrgOptions = {},
  /** The serial lane for the app schema changes (registration-lane.ts); inline when absent. */
  serialize?: SerializePersistent,
): Promise<{ failedApps: string[] }> {
  const {
    computeSetupStamp,
    readOrgSetupState,
    setupBuildId,
    stampMatches,
    withOrgSetupLock,
    writeOrgSetupStamp,
  } = await import("~/modules/apps/setup-stamp")
  const { apps: appsOverride, ...initOpts } = opts
  const apps = appsOverride ?? (await getDefaultApps())
  const stampApps = [...apps, ...(initOpts.extraApps ?? [])].map((a) => ({
    name: a.name,
    version: String(a.version),
  }))
  const expected = computeSetupStamp({
    buildId: setupBuildId(),
    apps: stampApps,
  })
  if (stampMatches(expected, await readOrgSetupState(orgId, stampApps))) {
    // In memory only, beside other orgs' first touches: no lane.
    const result = await initAppsForOrg(orgId, apps, { ...initOpts, skipOrgRows: true })
    await reconcileGoogleLogin(orgId)
    return result
  }
  // Double-checked: wait for any setup write in flight, then look again.
  const match = await withOrgSetupLock("org-setup-recheck", orgId, async (tx) =>
    stampMatches(expected, await readOrgSetupState(orgId, stampApps, tx)),
  )
  // Beside other orgs' setups: only a transaction that may change an app
  // schema (DDL on the tables every org shares) waits in the serial lane. An
  // org whose app schemas are current writes only its own rows, so a burst of
  // first touches after an upgrade is not one org at a time.
  const result = await initAppsForOrg(orgId, apps, {
    ...initOpts,
    skipOrgRows: match,
    serializeDdl: serialize,
  })
  await reconcileGoogleLogin(orgId)
  if (match) return result
  try {
    await orgSetupHookSeam.runSetupHooks(orgId)
  } catch (err) {
    // Not stamped: the hooks run again at the org's next setup.
    log.error({ err, orgId }, "Org setup hooks failed after app registration")
    return result
  }
  if (result.failedApps.length === 0) {
    await writeOrgSetupStamp(orgId, expected)
  } else {
    log.warn(
      { orgId, failedApps: result.failedApps },
      "Org setup stamp not written: some apps did not register",
    )
  }
  return result
}

/**
 * The per-process, in-memory setup of an org beyond its app registries, run on
 * its first touch in every process whatever its stamp: its PDF templates load
 * on demand (pdf/render.ts) and its MCP connections are projected here.
 */
async function setUpOrgInMemoryExtras(orgId: string): Promise<void> {
  await orgSetupHookSeam.runInMemoryExtras(orgId)
}

export async function ensureAppsForOrg(orgId: string, opts?: SetUpOrgOptions): Promise<void> {
  orgRuntimeLastTouch.set(orgId, Date.now())
  if (initializedOrgRuntimes.has(orgId)) return
  await orgRuntimeReleases.get(orgId)
  await (await orgRegistration()).ensure(orgId, opts)
}

/**
 * App schema changes at once. 1 by default: they run DDL on the app tables
 * every org shares, and concurrent registrations of different orgs have
 * deadlocked there.
 */
function registrationConcurrency(): number {
  const n = Number(process.env.APP_REGISTRATION_CONCURRENCY)
  return Number.isInteger(n) && n >= 1 ? n : 1
}

let orgRegistrationQueue: Promise<OrgRegistrationQueue<SetUpOrgOptions>> | null = null

/**
 * Every per-org registration in this process (registration-lane.ts), built at
 * the first one: its in-memory lane admits half of this process's
 * privileged pool at most (pool-plan.ts `memoryRegistrationConcurrency`), read
 * from the pool plan then rather than at import (the plan reads the env).
 */
function orgRegistration(): Promise<OrgRegistrationQueue<SetUpOrgOptions>> {
  orgRegistrationQueue ??= import("~/db/process-pool-plan").then(
    ({ poolPlan }) =>
      new OrgRegistrationQueue<SetUpOrgOptions>(orgRegistrationDeps(poolPlan.pools.privileged)),
  )
  return orgRegistrationQueue
}

const orgRegistrationDeps = (privilegedPoolSize: number): OrgRegistrationDeps<SetUpOrgOptions> => ({
  registered: initializedOrgRuntimes,
  inFlight: orgRuntimeInitPromises,
  registerOrgApps: async (orgId, opts, serialize) => {
    await setUpOrg(orgId, opts, serialize)
  },
  concurrency: registrationConcurrency(),
  memoryConcurrency: memoryRegistrationConcurrency(privilegedPoolSize),
  catalog: {
    generation: catalogGeneration,
    refreshOrgApps: async (orgId) => {
      const { registerApps } = await import("~/modules/apps/runtime")
      await registerApps(await getDefaultApps(), orgId)
    },
  },
})

/**
 * The ensure entry (S3) for every first touch of an org (authenticated
 * requests, WebSocket upgrades, job dispatch, the outbox, event dispatch, the
 * state materializer, inbound webhooks, OAuth callbacks): boot registers no
 * org, so an org this process has not registered is set up now and the caller
 * waits for it. Free for a registered org; a no-op for a deleted (or never
 * existing) org. Throws when the org's existence cannot be read.
 */
/**
 * What queued work brought an org's first touch, when it was queued work: an
 * outbox event or a job, with the time it was queued. Logged with the setup
 * it starts ("Org setup started"), so a reader can tell a setup this process
 * started on its own from one a queued event or job asked for.
 */
export interface OrgSetupTrigger {
  kind: "outbox-event" | "job"
  /** The event id, or `<queue>:<job id>`. */
  id: string
  /** When the event or job was queued (epoch ms). */
  queuedAt: number
}

/**
 * Load, once per process, the modules every org's first touch imports (the app
 * runtime, the kernel tools and the setup's own helpers). Evaluating them is
 * synchronous and takes hundreds of milliseconds on a cold process: left to
 * the first org's setup, it blocks the event loop under that org's first job or
 * request, and every other org's work with it. Boot calls this before the
 * process takes jobs or turns ready; each org's setup then imports them from
 * the module cache. Idempotent.
 */
export async function loadOrgSetupModules(): Promise<void> {
  await Promise.all([
    import("~/modules/apps/runtime"),
    import("~/modules/audit/timeline"),
    import("~/modules/agent/tools/kernel-tools"),
    import("~/modules/apps/kernel-bulk"),
    import("~/modules/apps/app-registries"),
    import("~/infra/events/event-bus"),
    import("~/modules/apps/setup-stamp"),
    import("~/modules/apps/org-apps"),
    import("~/db/process-pool-plan"),
    import("~/modules/apps/org-runtime-release"),
  ])
}

export async function awaitOrgApps(orgId: string, trigger?: OrgSetupTrigger): Promise<void> {
  if (initializedOrgRuntimes.has(orgId)) {
    orgRuntimeLastTouch.set(orgId, Date.now())
    return
  }
  // Being released (idle): set it up again once the release is done.
  await orgRuntimeReleases.get(orgId)
  if (initializedOrgRuntimes.has(orgId)) {
    orgRuntimeLastTouch.set(orgId, Date.now())
    return
  }
  const inFlight = orgRuntimeInitPromises.get(orgId)
  if (inFlight) return inFlight
  const { isOrgMissingAsync, UUID_RE } = await import("~/modules/apps/org-apps")
  // Not an org id shape: no organization row can carry it.
  if (!UUID_RE.test(orgId)) return
  if (await isOrgMissingAsync(orgId)) {
    // A later registry miss for it is expected, not a missing ensure (H3 guard).
    rememberMissingOrg(orgId)
    return
  }
  orgsKnownMissing.delete(orgId)
  orgRuntimeLastTouch.set(orgId, Date.now())
  log.info({ orgId, trigger: trigger ?? null }, "Org setup started")
  return (await orgRegistration()).ensure(orgId)
}

/**
 * A CLI process (`liaison config apply`, ...) runs next to the serving server
 * and rarely executes a sandboxed tool: its pool starts empty and creates a
 * slot only when a tool actually runs, instead of pre-warming four QuickJS
 * modules on a box the server is using.
 */
export function sandboxPoolOptionsForProcess(): { initialSize?: number } {
  return process.env.LIAISON_CLI === "1" ? { initialSize: 0 } : {}
}

/**
 * Re-discover apps on disk and register them for one org, initialized or not
 * (`reloadInstalledApps`). An install or upgrade already switches every org
 * initialized in this process (activation.ts); this also covers an org that has
 * not registered yet, which the catalog install and the test harnesses need.
 * `registerApps` is idempotent per app version. The orgRuntimeInit flag is left
 * as is: only the app registries are refreshed, not the one-shot kernel-bulk /
 * agent-tools / timeline registrations from `initAppsForOrg`.
 */
export async function reloadInstalledApps(orgId: string): Promise<void> {
  const { registerApps } = await import("~/modules/apps/runtime")
  // Re-discover: the install root may hold what this process has not read yet.
  bumpCatalogGeneration()
  const apps = await getDefaultApps()
  await registerApps(apps, orgId)
  // The catalog on disk may have changed (an install, an upgrade): the files
  // SELECT policy and the search settings follow the catalog, never the
  // registries. Both are no-ops when the catalog's derivations are unchanged.
  const { rebuildFilesSelectPolicy } = await import("~/infra/boot-phase10")
  await rebuildFilesSelectPolicy()
  await extendSearchSettingsForCatalog()
}

/**
 * Make the catalog's searchable entities' filter fields part of the live search
 * index settings (drift.ts `ensureSearchSettingsCover`): a no-op before boot
 * and when nothing new is declared. Never fails app registration.
 */
async function extendSearchSettingsForCatalog(): Promise<void> {
  try {
    const { ensureSearchSettingsCoverCatalog } = await import("~/modules/search/drift")
    await ensureSearchSettingsCoverCatalog()
  } catch (err) {
    log.warn({ err }, "Search settings extension after a catalog change failed")
  }
}
