// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one door app code runs through. Every site that runs an app's handler
// (tools, webhooks, jobs, event handlers, polls, search, attention providers,
// before-disconnect hooks, exports) calls `runApp`, and the choice of executor
// is made here, in `selectExecutor`, and nowhere else:
//
//   inprocess  trusted code, on the host's in-process QuickJS pool (executeInSandbox)
//   workers    an untrusted app listed for the remote V8 isolate loader
//              (LIAISON_WORKERS_APPS) whose installed version has a Worker
//              bundle (LIAISON_WORKERS_BUNDLES), when Workers is configured
//              and this process has role "all" (workers/config.ts)
//   pool       everything else, on the out-of-process worker pool
//
// A listed app that cannot run on Workers (no bundle for its installed
// version) runs on the pool with a warning per run. Every run of a listed app
// writes one timing record tagged with the executor that ran it
// (workers/timings.ts, kind "run").
//
// A new executor is one more arm of `selectExecutor` and of the switch in
// `runApp`; no call site changes. The sandboxes that do not run app handlers
// (tool summarizers, imports transforms, PDF templates, the mail sync bundle)
// stay outside this door.

import { dirname } from "node:path"
import { and, eq, isNull, or } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import {
  forWorkersRun,
  isWorkersRunBridge,
  secretConfigKeysOf,
} from "~/modules/apps/sandbox/bridge/secret-free"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { getSandboxPool } from "~/modules/apps/sandbox/pool"
import {
  type ExecPriority,
  getWorkerPool,
  initWorkerPool,
  type WorkerExecOptions,
} from "~/modules/apps/sandbox/worker-pool"
import {
  readWorkersConfig,
  type WorkersConfig,
  workersBundleSha,
} from "~/modules/apps/workers/config"
import { executeOnWorkers, type WorkersRunInfo } from "~/modules/apps/workers/executor"
import { recordRunTiming } from "~/modules/apps/workers/timings"

const log = rootLogger.child({ module: "run-app" })

/** The installed version an app runs at, and the sha256 of its package. */
export interface InstalledIdentity {
  version: string
  sha256: string
}

export interface RunAppOptions {
  /** The handler is platform code: it may run in-process. */
  trusted: boolean
  appName: string
  orgId: string
  /**
   * The installed-app record this run belongs to. Omitted: resolved on demand by
   * `resolveInstalledIdentity` (only an executor that needs it asks). `null`: the
   * app is not a runtime install (an in-tree app).
   */
  installed?: InstalledIdentity | null
  /** Where the bundle lives. Required when `bundleSource` is not given. */
  bundlePath?: string
  /** The bundle text, when the site has loaded (or reshaped) it already. */
  bundleSource?: string
  exportName: string
  params: unknown
  /** Positional args after `(params, ctx)`, e.g. a webhook's headers. */
  extraArgs?: unknown[]
  bridge: Record<string, (...args: any[]) => any>
  timeoutMs?: number
  signal?: AbortSignal
  priority?: ExecPriority
  /** The worker pool's tenant key; set by the sites that set it before. */
  appId?: string
  syncContext?: WorkerExecOptions["syncContext"]
  nested?: boolean
  nestedParentKey?: string
  backgroundGroup?: string
  toolName?: string
  /**
   * What kind of entry point this run is, as `<kind>:<name>` (`job:sync`,
   * `webhook:onOrder`, `event:onCreated`, ...), for the run timing record.
   * Tools need not set it (`tool:<toolName>`).
   */
  entry?: string
  /**
   * This run's own execution token, when the site minted one (tools): a nested
   * run names it as its `nestedParentKey`, which is how its record knows its
   * parent app.
   */
  executionToken?: string
  /**
   * The bridge holds an ambient database transaction open across the whole run
   * (atomic tools, primary webhook delivery, ambient jobs, event handlers, polls).
   * An executor whose bridge calls cannot reach that transaction must not take it.
   */
  holdsTx: boolean
}

/** Which executor runs this call. */
export type AppExecutor = "inprocess" | "pool" | "workers"

/**
 * THE executor choice: trusted code in-process; an untrusted run with a Workers
 * bundle (resolved by `resolveWorkersTarget`) on Workers; everything else in
 * the worker pool. A further executor is added here (and in `runApp`'s switch)
 * only.
 */
export function selectExecutor(opts: {
  trusted: boolean
  workersBundleSha?: string | undefined
}): AppExecutor {
  if (opts.trusted) return "inprocess"
  return opts.workersBundleSha ? "workers" : "pool"
}

/** Where a Workers run goes: the configuration, the installed version and its bundle. */
export interface WorkersTarget {
  config: WorkersConfig
  version: string
  sha256: string
}

/**
 * The Workers target of a run, or null (QuickJS). Only an untrusted app listed
 * in a usable Workers configuration is looked at; a listed app whose installed
 * version has no bundle entry warns (every run) and runs on the pool.
 */
export async function resolveWorkersTarget(
  opts: Pick<RunAppOptions, "trusted" | "appName" | "orgId" | "installed" | "bundlePath">,
): Promise<WorkersTarget | null> {
  if (opts.trusted) return null
  const config = readWorkersConfig()
  if (!config?.apps.has(opts.appName)) return null
  const identity =
    opts.installed !== undefined
      ? opts.installed
      : await resolveInstalledIdentity(opts.appName, opts.orgId, opts.bundlePath)
  const sha = identity ? workersBundleSha(config, opts.appName, identity.version) : undefined
  if (!identity || !sha) {
    log.warn(
      { app: opts.appName, orgId: opts.orgId, version: identity?.version ?? null },
      "App listed for Workers has no Worker bundle for its installed version; running on QuickJS",
    )
    return null
  }
  return { config, version: identity.version, sha256: sha }
}

/** Whether this run would go to Workers (a site that builds a bridge per executor asks). */
export async function appRunsOnWorkers(
  opts: Pick<RunAppOptions, "trusted" | "appName" | "orgId" | "installed" | "bundlePath">,
): Promise<boolean> {
  return (await resolveWorkersTarget(opts)) !== null
}

/** The apps whose runs write a timing record (LIAISON_WORKERS_APPS, whatever else is set). */
function timedApps(): ReadonlySet<string> {
  const raw = env.LIAISON_WORKERS_APPS ?? ""
  if (raw === timedAppsRaw) return timedAppsSet
  timedAppsRaw = raw
  timedAppsSet = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  return timedAppsSet
}
let timedAppsRaw = ""
let timedAppsSet: ReadonlySet<string> = new Set()

/** Running executions by token -> app, so a nested run's record names its parent app. */
const runningExecutions = new Map<string, string>()

export async function runApp(opts: RunAppOptions): Promise<unknown> {
  const timed = timedApps().has(opts.appName)
  const started = Date.now()
  if (opts.executionToken) runningExecutions.set(opts.executionToken, opts.appName)
  const workersTarget = await resolveWorkersTarget(opts)
  const executor = selectExecutor({
    trusted: opts.trusted,
    workersBundleSha: workersTarget?.sha256,
  })
  let info: WorkersRunInfo = {}
  let ok = false
  try {
    const result = await runOnExecutor(opts, executor, workersTarget, (i) => {
      info = i
    })
    ok = true
    return result
  } finally {
    if (opts.executionToken) runningExecutions.delete(opts.executionToken)
    if (timed) {
      const parentApp =
        opts.nested && opts.nestedParentKey
          ? runningExecutions.get(opts.nestedParentKey)
          : undefined
      recordRunTiming({
        kind: "run",
        ...(info.runId ? { runId: info.runId } : {}),
        app: opts.appName,
        entry:
          opts.entry ?? (opts.toolName ? `tool:${opts.toolName}` : `handler:${opts.exportName}`),
        executor: executor === "pool" ? "quickjs" : executor,
        nested: opts.nested === true,
        ...(parentApp ? { parentApp } : {}),
        ms: Date.now() - started,
        ok,
        at: started,
        ...(info.loader ? { loader: info.loader } : {}),
        ...(info.sleepMs !== undefined ? { sleepMs: info.sleepMs } : {}),
        ...(info.sleepExact !== undefined ? { sleepExact: info.sleepExact } : {}),
      })
    }
  }
}

async function runOnExecutor(
  opts: RunAppOptions,
  executor: AppExecutor,
  workersTarget: WorkersTarget | null,
  onInfo: (info: WorkersRunInfo) => void,
): Promise<unknown> {
  if (executor === "workers" && workersTarget) {
    // The isolate lives off this server: no method may hand it a secret. The
    // dispatching site may have built the bridge so already (workersRun);
    // otherwise it is marked here, before any call, in the caller's frame. The
    // refused config keys are the ones the bridge's own config_get decrypts
    // (recorded on it when it was built); a bridge that records none refuses
    // every config_get (fail closed).
    const bridge = isWorkersRunBridge(opts.bridge)
      ? opts.bridge
      : forWorkersRun(opts.bridge, { secretConfigKeys: secretConfigKeysOf(opts.bridge) })
    return executeOnWorkers(
      {
        config: workersTarget.config,
        appName: opts.appName,
        orgId: opts.orgId,
        version: workersTarget.version,
        bundleSha256: workersTarget.sha256,
        exportName: opts.exportName,
        params: opts.params,
        ...(opts.extraArgs !== undefined ? { extraArgs: opts.extraArgs } : {}),
        approval: opts.syncContext?.approval ?? null,
        bridge,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        holdsTx: opts.holdsTx,
        nested: opts.nested === true,
        ...(opts.nestedParentKey !== undefined ? { nestedParentKey: opts.nestedParentKey } : {}),
      },
      onInfo,
    )
  }
  const bundleSource = opts.bundleSource ?? (await loadBundleFor(opts))
  switch (executor) {
    case "inprocess":
      return executeInSandbox({
        pool: getSandboxPool(),
        bundleSource,
        exportName: opts.exportName,
        params: opts.params,
        bridge: opts.bridge,
        ...(opts.extraArgs !== undefined ? { extraArgs: opts.extraArgs } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      })
    case "pool": {
      await initWorkerPool()
      const exec: WorkerExecOptions = {
        bundleSource,
        exportName: opts.exportName,
        params: opts.params,
        bridge: opts.bridge,
      }
      if (opts.extraArgs !== undefined) exec.extraArgs = opts.extraArgs
      if (opts.timeoutMs !== undefined) exec.timeoutMs = opts.timeoutMs
      if (opts.syncContext !== undefined) exec.syncContext = opts.syncContext
      if (opts.priority !== undefined) exec.priority = opts.priority
      if (opts.backgroundGroup !== undefined) exec.backgroundGroup = opts.backgroundGroup
      if (opts.nested !== undefined) exec.nested = opts.nested
      if (opts.nestedParentKey !== undefined) exec.nestedParentKey = opts.nestedParentKey
      if (opts.signal !== undefined) exec.signal = opts.signal
      if (opts.appId !== undefined) exec.appId = opts.appId
      if (opts.toolName !== undefined) exec.toolName = opts.toolName
      return getWorkerPool().execute(exec)
    }
    case "workers":
      throw new Error(`runApp(${opts.appName}:${opts.exportName}): Workers run without a target`)
    default: {
      const never: never = executor
      throw new Error(`Unknown app executor: ${String(never)}`)
    }
  }
}

function loadBundleFor(opts: RunAppOptions): Promise<string> {
  if (!opts.bundlePath) {
    throw new Error(`runApp(${opts.appName}:${opts.exportName}) needs a bundlePath or bundleSource`)
  }
  return loadBundle(opts.bundlePath)
}

// -- Installed identity --------------------------------------------------------

const identityCache = new Map<string, InstalledIdentity | null>()

/**
 * The installed version and package sha256 an app runs at for an org, from the
 * installed-app record (`kernel.apps_installed`). `null` for an app that is not
 * a runtime install (an in-tree app, or no visible record).
 *
 * With a `bundlePath` under the install layout (`<root>/<app>/<version>/bundle.js`)
 * the version is the bundle's own version directory and the answer is cached per
 * process per version directory (and org): a version directory only ever holds
 * one version. Without one, the org's active version is read, uncached.
 */
export async function resolveInstalledIdentity(
  appName: string,
  orgId: string,
  bundlePath?: string,
): Promise<InstalledIdentity | null> {
  if (bundlePath === undefined) return readActiveIdentity(appName, orgId)
  const versionDir = dirname(bundlePath)
  const key = `${orgId}\0${versionDir}`
  if (identityCache.has(key)) return identityCache.get(key) ?? null
  const version = versionOfInstalledBundle(appName, versionDir)
  const identity = version === null ? null : await readIdentity(appName, orgId, version)
  identityCache.set(key, identity)
  return identity
}

/** Forget every cached identity (an activation, or a test). */
export function clearInstalledIdentityCache(): void {
  identityCache.clear()
}

/** `<root>/<app>/<version>` -> `<version>`; anything else is not an installed bundle. */
function versionOfInstalledBundle(appName: string, versionDir: string): string | null {
  const appDir = dirname(versionDir)
  if (appDir === versionDir || appDir.split(/[\\/]/).pop() !== appName) return null
  const version = versionDir.split(/[\\/]/).pop()
  return version && !version.startsWith(".") ? version : null
}

const visibleTo = (orgId: string) => or(isNull(appsInstalled.orgId), eq(appsInstalled.orgId, orgId))

async function readIdentity(
  appName: string,
  orgId: string,
  version: string,
): Promise<InstalledIdentity | null> {
  const [row] = await withSystemDb("run-app:installed-identity", (db) =>
    db
      .select({ version: appsInstalled.version, sha256: appsInstalled.sha256 })
      .from(appsInstalled)
      .where(
        and(eq(appsInstalled.name, appName), eq(appsInstalled.version, version), visibleTo(orgId)),
      )
      .limit(1),
  )
  return row ?? null
}

async function readActiveIdentity(
  appName: string,
  orgId: string,
): Promise<InstalledIdentity | null> {
  const [row] = await withSystemDb("run-app:active-identity", (db) =>
    db
      .select({ version: appsInstalled.version, sha256: appsInstalled.sha256 })
      .from(appsActiveVersion)
      .innerJoin(
        appsInstalled,
        and(
          eq(appsInstalled.name, appsActiveVersion.name),
          eq(appsInstalled.version, appsActiveVersion.version),
        ),
      )
      .where(and(eq(appsActiveVersion.name, appName), visibleTo(orgId)))
      .limit(1),
  )
  return row ?? null
}
