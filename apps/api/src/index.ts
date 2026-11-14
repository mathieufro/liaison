// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hono } from "hono"
import { app } from "~/app"
import { registerKnowledgeJobs } from "~/apps/knowledge/knowledge-jobs"
import { sql } from "~/db"
import { checkServerLimit, readServerLimit, reportPoolPlan } from "~/db/pool-boot"
import { poolPlan } from "~/db/process-pool-plan"
import { runPhase10Boot } from "~/infra/boot-phase10"
import { initEmailProvider, initSystemEmailProvider, registerDemoAlertChannel } from "~/infra/email"
import { initEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { registerOutboxSingleton } from "~/infra/events/outbox-worker"
import { INSTANCE_ID } from "~/infra/instance-id"
import { registerLiveStateSweep, startInstanceHeartbeat } from "~/infra/instance-registry"
import { startEventRoutineSync } from "~/infra/jobs/event-routine-subscriber"
import {
  registerAppCronFanout,
  startAppCronFanoutUpkeep,
  startLegacySchedulerSweep,
  upsertAppCronFanout,
} from "~/infra/jobs/fanout-runtime"
import {
  bindCatalogAppQueues,
  deferJobWorkersUntilBootComplete,
  disableJobWorkers,
  hostJobWorkers,
  setJobsLeadership,
  startDeferredJobWorkers,
} from "~/infra/jobs/jobs"
import { registerKernelJobs } from "~/infra/jobs/kernel-jobs"
import { registerLegacyKernelQueueSingleton } from "~/infra/jobs/legacy-kernel-queue"
import { registerLoadSyntheticWorker } from "~/infra/jobs/load-synthetic"
import {
  kernelSlotsWanted,
  LEGACY_DRAIN_CONCURRENCY,
  parseConcurrencyOverrides,
  planKernelSlots,
} from "~/infra/jobs/queue-classes"
import { registerWebhookInboxJobs } from "~/infra/jobs/webhook-inbox-jobs"
import { initWebhookWorker } from "~/infra/jobs/webhook-worker"
import { startLeadership } from "~/infra/leadership"
import { setWsManager, WebSocketManager } from "~/infra/websocket"
import { env, validateControlPlaneEnv } from "~/lib/env"
import { loadHarnessEnabled } from "~/lib/load-harness"
import { rootLogger } from "~/lib/logger"
import {
  assertManagedBoot,
  legacyControlPlaneBootProblem,
  managedBootRequired,
} from "~/lib/managed-boot"
import { registerProcessHandlers } from "~/lib/process-handlers"
import { currentRole, hostsJobs, isLeaderEligible, servesApi } from "~/lib/process-role"
import { markBootComplete } from "~/lib/readiness"
import { redis } from "~/lib/redis"
import { createServer, type WsData } from "~/lib/server"
import {
  haltBootIfShuttingDown,
  installShutdownSignals,
  isShuttingDown,
  markBootFinished,
  registerShutdownPhase,
  shutdownBudgets,
} from "~/lib/shutdown"
import { registerProcessShutdownPhases } from "~/lib/shutdown-phases"
import { startInternalListener } from "~/modules/agent/mailbox-plaintext/mailbox-forward"
import { registerConnectionTeardownSweep } from "~/modules/apps/connections/revoke"
import { awaitOrgApps, getDefaultApps, loadOrgSetupModules } from "~/modules/apps/init"
import { startAppUsageRecorder, stopAppUsageRecorder } from "~/modules/apps/usage/app-usage"
import { startRunHealth, stopRunHealth } from "~/modules/apps/usage/run-health"
import { registerRunPoolGauges } from "~/modules/apps/usage/run-pool-gauges"
import { startVersionsInUseHeartbeat } from "~/modules/apps/versions-in-use"
import { internalAppBridgeRoute } from "~/modules/apps/workers/bridge-forward"
import { startBridgeListener } from "~/modules/apps/workers/bridge-listener"
import { checkSandboxAtBoot } from "~/modules/apps/workers/sandbox-release"
import { consumeWsTicket } from "~/modules/auth/ws-ticket"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { healthzRoutes } from "~/modules/healthz"
import { readyzRoutes } from "~/modules/healthz/readyz"
import { registerMailboxBackfillWorker } from "~/modules/mailbox-crypto/backfill-job"

// Must run before any await -- catches an uncaught exception/unhandled rejection anywhere
// in boot or the request lifecycle, logs it fatal (captured by the watchdog's log stream),
// and exits so the container restarts cleanly instead of limping on in an unknown state.
registerProcessHandlers(rootLogger)
// The one SIGTERM/SIGINT entry (lib/shutdown.ts): modules register phases on it.
installShutdownSignals()

// What this process runs (LIAISON_ROLE, lib/process-role.ts): `all` is the
// single container (everything below), `api` serves HTTP + WebSocket and runs
// no job worker and no singleton, `worker` runs the jobs and the singletons
// behind a health-only server.
const role = currentRole()
rootLogger.info({ role, instanceId: INSTANCE_ID }, "Process role")

// THE POOL BUDGET, first: every pool was sized at import from one connection
// budget and this role (db/pool-plan.ts). A topology whose one release cannot
// fit refuses here, before Redis or HTTP; two releases side by side that
// cannot fit warn. Then the same rule against the server's own limit.
{
  const overrides = parseConcurrencyOverrides(env.JOB_QUEUE_CONCURRENCY)
  const kernelSlots = hostsJobs(role)
    ? {
        planned: Object.values(planKernelSlots(overrides, poolPlan.pools.privileged).slots).reduce(
          (n, c) => n + c,
          LEGACY_DRAIN_CONCURRENCY,
        ),
        wanted: kernelSlotsWanted(overrides).total,
      }
    : undefined
  let verdict = reportPoolPlan(poolPlan, rootLogger, {
    endpoint: env.DB_CELL_ENDPOINT,
    kernelSlots,
  })
  if (verdict !== "refuse" && env.DB_CELL_ENDPOINT === "direct") {
    try {
      const limit = await readServerLimit(sql)
      verdict = checkServerLimit(poolPlan, limit, rootLogger, {
        cellMax: env.DB_CELL_MAX_CONNECTIONS,
        strict: env.DB_CELL_STRICT,
      })
    } catch (err) {
      rootLogger.warn({ err }, "pool budget: could not read the database's max_connections")
    }
  }
  if (verdict === "refuse") {
    // The fatal line is the operator's only evidence: let the async log write land.
    rootLogger.flush()
    await new Promise((resolve) => setTimeout(resolve, 200))
    process.exit(1)
  }
}

// The legacy control-plane pair alone once switched managed on without the
// checks below; it no longer does, so such a server boots self-hosted and says
// what to set (lib/managed-boot.ts).
const legacyControlPlane = legacyControlPlaneBootProblem()
if (legacyControlPlane) rootLogger.warn(legacyControlPlane)

// App screens on origins of their own (lib/app-frame-host.ts): a frame template on
// the app's own site, or one that can name an org host, is refused on a managed
// cell; a self-hosted server boots and says why it should not share the site.
{
  const { appFrameTemplateProblems } = await import("~/lib/app-frame-host")
  const { registrableDomain } = await import("~/modules/demo/demo-email")
  const frame = appFrameTemplateProblems(process.env, registrableDomain)
  for (const warning of frame.warn) rootLogger.warn(warning)
  if (frame.refuse.length > 0) {
    rootLogger.fatal(
      { problems: frame.refuse },
      `LIAISON_APP_FRAME_ORIGIN_TEMPLATE cannot be used:\n- ${frame.refuse.join("\n- ")}`,
    )
    rootLogger.flush()
    await new Promise((resolve) => setTimeout(resolve, 200))
    process.exit(1)
  }
}

// The managed edition refuses to boot without its operator org, org host
// template, control plane endpoint and installed identity (lib/managed-boot.ts).
if (managedBootRequired()) {
  try {
    await assertManagedBoot()
  } catch (err) {
    rootLogger.fatal({ err }, (err as Error).message)
    rootLogger.flush()
    await new Promise((resolve) => setTimeout(resolve, 200))
    process.exit(1)
  }
}

// Initialize email provider (SMTP when configured, console fallback)
initEmailProvider()
// Initialize the system/auth email channel (Resend when SYSTEM_RESEND_API_KEY
// is set, else inherits the default provider). Keeps sign-in/invite/reset mail
// deliverable even when the default provider is a sink.
initSystemEmailProvider()
// Demo mode: the owner alert gets the demo system mail channel BEFORE any org's
// runtime is registered below. Visitor spend on the box key is off until that
// channel exists, and each org's `web_search` is advertised (or not) from that
// state when its tools are registered: wired later, every visitor workspace came
// up without web search after each restart.
if (isDemoModeEnabled()) registerDemoAlertChannel()

// Initialize event bus for cross-process Redis pub/sub
initEventBus()
// Instance liveness (infra/instance-registry.ts): every role writes its heartbeat
// record; entries this process owns in Redis are ignored once it lapses.
// The internal listener (every role: api and worker turns both mint mailbox
// requests and dispatch app runs) is where another process forwards a mailbox
// answer this one minted, or a bridge call of an app run this one dispatched.
// Its address rides the heartbeat record; it is never the public PORT.
const internalListener = await startInternalListener({ extraRoutes: [internalAppBridgeRoute()] })
await startInstanceHeartbeat({ role, pid: process.pid, internalUrl: internalListener.url })
// The app versions this process loads, so a prune never deletes one under it
// while two releases overlap (modules/apps/versions-in-use.ts).
startVersionsInUseHeartbeat()
registerProcessShutdownPhases({ internalListener })
// The bridge-only listener for the sandbox network (every role: any process
// may dispatch a sandbox run), when the instance's sandbox service is set up
// (modules/apps/workers/bridge-listener.ts).
if (env.LIAISON_APP_BRIDGE_PORT !== undefined) {
  startBridgeListener(app, { port: env.LIAISON_APP_BRIDGE_PORT })
}
// The release handshake with the sandbox service (when one is configured):
// a service left on another release is logged here, and /healthz reports it.
void checkSandboxAtBoot().catch(() => undefined)
// The orchestrator's stop grace period must exceed hardDeadlineMs (+ 5 s), or
// it kills the process mid-drain (docs/self-hosting/docker.md).
rootLogger.info(shutdownBudgets(), "Shutdown budgets (ms from SIGTERM)")
if (!env.MAIL_SEND_GUARD_ENFORCE) {
  rootLogger.error(
    "MAIL_SEND_GUARD_ENFORCE=0: staged mail is checked for opt-outs only, a reply no longer stops it",
  )
}
// From here a SIGTERM runs the shutdown phases: boot halts at each step below.
await haltBootIfShuttingDown()

export const wsManager = new WebSocketManager(redis)
setWsManager(wsManager)
// Desktop `notify` frames addressed to this instance's connections by another
// instance arrive on its own channel, over a dedicated subscriber connection.
await wsManager.startNotifyDelivery(redis.duplicate())

registerEventSubscribers(wsManager)
// Event-routine subscriptions follow the cell (event-routine-subscriber.ts): a
// routine changed on another process is announced, and a resync covers a lost one.
await startEventRoutineSync()

// The modules every org's setup imports load now, before this process takes a
// job or turns ready, so the first org's setup does not block the event loop
// evaluating them (modules/apps/init.ts loadOrgSetupModules).
await loadOrgSetupModules()

// Register kernel scheduled jobs + webhook retry worker. Phase 10 register*
// happens after app manifests are loaded (post createServer block), then the
// outbox worker is started so durable consumers can pick up events.
//
// This process is THE job host (infra/jobs/jobs.ts: hosting is opt-in, so the
// CLI and one-shot scripts that share this import graph never take jobs).
// Job workers start PAUSED until per-org app registration completes below:
// jobs left in Redis from before a restart (routine-tick, agent-reinvoke,
// knowledge indexing…) would otherwise run sandbox tool calls against empty
// app registries and fail with cross-app schema errors.
//
// An `api` process registers every handler too (enqueueing asserts a local
// handler) but never hosts a Worker: disabled before any registration.
if (hostsJobs(role)) {
  deferJobWorkersUntilBootComplete()
  hostJobWorkers()
  // A3: consume every catalog app queue from boot, without any org registered
  // here (the manifest set is instance-global). The dispatcher sets a job's org
  // up before it looks up the org's handler (infra/jobs/jobs.ts processJob).
  const catalog = await getDefaultApps()
  bindCatalogAppQueues(catalog)
  // One scheduler per (app, job) of the catalog, fanned out over orgs at each
  // tick (infra/jobs/fanout.ts). Upsert only: removal follows an activation, an
  // uninstall or the leader's reconcile, never a boot that may be the older
  // release of a rolling deploy.
  await upsertAppCronFanout(catalog)
  startAppCronFanoutUpkeep(getDefaultApps)
  // Upgrade: the leader removes the pre-fan-out per-org schedulers, once per acquire.
  startLegacySchedulerSweep()
} else {
  disableJobWorkers()
}
// The fan-out tick's handler, in every role (enqueueing asserts a local handler).
registerAppCronFanout()
await registerKernelJobs()
await registerKnowledgeJobs()
initWebhookWorker()
await registerWebhookInboxJobs()
// Per-org app usage (modules/apps/usage/app-usage.ts): counted as runs settle,
// written in batches; what is pending is written at shutdown.
startAppUsageRecorder()
registerShutdownPhase({
  name: "app-usage-flush",
  at: "after-drain",
  deadlineMs: 3_000,
  run: () => stopAppUsageRecorder(),
})
// App-run health (modules/apps/usage/run-health.ts): per app and lane, rolling
// windows in memory and in Redis, read by /diag and the admin read.
registerRunPoolGauges()
startRunHealth()
registerShutdownPhase({
  name: "app-run-health-flush",
  at: "after-drain",
  deadlineMs: 2_000,
  run: () => stopRunHealth(),
})
// The load harness's synthetic job, only on a box with the harness key.
if (loadHarnessEnabled()) registerLoadSyntheticWorker()

// RLS enforcement: verify liaison_rls role exists in production (M-14: tolerate transient Postgres failure)
if (env.NODE_ENV === "production") {
  try {
    const [{ exists }] =
      await sql`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') AS "exists"`
    if (!exists) {
      rootLogger.fatal("RLS enforcement requires the liaison_rls role. Run migrations.")
      process.exit(1)
    }
  } catch (err) {
    rootLogger.fatal({ err }, "Cannot verify RLS role — is Postgres available? Exiting.")
    process.exit(1)
  }
}

// Request login containment (migration 0178). With DATABASE_REQUEST_PASSWORD
// set, request transactions log in as liaison_request, which must reach no
// superuser or BYPASSRLS role: a production server whose request login can is
// refused. Unset, requests share the privileged login, and production says so.
if (env.NODE_ENV === "production") {
  try {
    const { requestLoginReach } = await import("~/db/rls")
    const { login, reach } = await requestLoginReach()
    if (env.DATABASE_REQUEST_PASSWORD && reach.length > 0) {
      rootLogger.fatal(
        { login, reach },
        "The request login can step into a privileged role: it must be a member of liaison_rls only (migration 0178)",
      )
      process.exit(1)
    }
    if (!env.DATABASE_REQUEST_PASSWORD) {
      rootLogger.warn(
        { login, reach },
        "Request transactions run on the privileged login: set DATABASE_REQUEST_PASSWORD so they run as liaison_request",
      )
    }
  } catch (err) {
    rootLogger.fatal({ err }, "Cannot verify the request login. Exiting.")
    process.exit(1)
  }
}

// Reject startup if DEVICE_FLOW_CLIENTS is empty in production — any client ID would be accepted
if (env.DEVICE_FLOW_CLIENTS.length === 0 && env.NODE_ENV === "production") {
  rootLogger.fatal("DEVICE_FLOW_CLIENTS must not be empty in production")
  process.exit(1)
}

// Control-plane env matrix: both vars must be set together or unset together.
try {
  validateControlPlaneEnv({
    NODE_ENV: env.NODE_ENV,
    CONTROL_PLANE_URL: env.CONTROL_PLANE_URL,
    CONTROL_PLANE_API_KEY: env.CONTROL_PLANE_API_KEY,
  })
} catch (err) {
  rootLogger.fatal({ err }, "Control plane env half-configured")
  process.exit(1)
}

// WebSocket upgrade handler: ticket-based authentication
const onUpgrade = async (req: Request): Promise<WsData | null> => {
  const url = new URL(req.url)
  const ticket = url.searchParams.get("ticket")

  if (ticket) {
    const payload = await consumeWsTicket(redis, ticket, req)
    if (payload) {
      // The org's apps before its first frame (a no-op once it is registered).
      // A failed registration does not refuse the socket: its next demand retries.
      await awaitOrgApps(payload.orgId).catch((err) =>
        rootLogger.error(
          { err, orgId: payload.orgId },
          "App registration before a WebSocket failed",
        ),
      )
      return {
        ...payload,
        authorized: true,
        authVersion: payload.authVersion,
        permissionVersion: payload.permissionVersion,
      }
    }
  }

  return { userId: "", orgId: "", scopes: [], dimensionGrants: {}, authorized: false }
}

try {
  // Seed the global model-pricing catalog so chat works on a fresh instance —
  // an empty model_pricing table makes every model fail the "Model not available"
  // pre-check. Idempotent (inserts only missing rows). Global, so it runs before
  // (and independent of) per-org app registration.
  const { seedModelPricing } = await import("~/infra/seed-model-pricing")
  await seedModelPricing()

  // Boot registers no org (S19): its time does not grow with the number of
  // orgs. Each org's apps register on its first touch in this process (an
  // authenticated request, a WebSocket, a job, an event, an inbound webhook:
  // `awaitOrgApps`). PDF templates load on demand per app (pdf/render.ts); the
  // files policy and search settings are the setup step's
  // (db/reconcile-catalog-boot.ts).

  // Phase 10: durable consumers, workers and scheduled jobs.
  await haltBootIfShuttingDown()
  await runPhase10Boot()
  rootLogger.info("Phase 10 boot complete")

  // Phase 15: inbound MCP-client kernel module: the engine and its reap timer
  // only. An org's connections are projected at its first touch.
  try {
    const { initMcpClient } = await import("~/modules/mcp-client")
    await initMcpClient()
    rootLogger.info("MCP-client (Phase 15) boot complete")
  } catch (err) {
    rootLogger.error({ err }, "MCP-client boot failed — feature disabled this run")
  }
} catch (err) {
  // A step cut by the shutdown is not a failed start: the coordinator exits 0.
  if (isShuttingDown()) {
    rootLogger.warn({ err }, "A boot step failed during shutdown")
    await haltBootIfShuttingDown()
  }
  rootLogger.fatal({ err }, "Startup failed")
  process.exit(1)
}

// Leadership: Patroni drives the BullMQ workers' pause/resume (the jobs gate;
// off without SINGLETON_LEADER_URL -> announces open once), and the Redis
// leader lease elects the process that runs the singletons. Alone in its cell,
// this process takes the lease here, at boot. Started BEFORE releasing the
// workers so a to-be-standby never runs them, even briefly.
// An `api` process starts leadership too (never eligible, so `isLeader()` stays
// false): the mailbox backfill below refuses a process without it.
// A SIGTERM during boot: the remaining steps are skipped (lib/shutdown.ts).
await haltBootIfShuttingDown()
await startLeadership({ role, onJobsGate: hostsJobs(role) ? setJobsLeadership : undefined })
// The mailbox backfill is a SINGLETON, and it is registered here rather than in
// kernel-jobs.ts because that file is called from three entrypoints and would
// register it in all of them. It throws if the monitor above did not start, so
// a process without leadership state refuses to boot rather than sealing every
// mailbox on every node (blueprint Task 12.1, amendment A7).
await registerMailboxBackfillWorker()

// Sandbox WORKER pool (out-of-process, untrusted manifest tools): init eagerly,
// BEFORE the job workers release their backlog and before the server takes
// traffic. Left lazy, the first run-tool triggered init while the main thread
// was already grinding through the boot backlog's in-process sandbox handlers,
// stretching the 4 worker spawns to minutes -- during which EVERY run-tool call
// 504'd (the post-deploy "no counts + error toasts" outage window).
try {
  const { initWorkerPool, getWorkerPool } = await import("~/modules/apps/sandbox/worker-pool")
  await initWorkerPool()
  // Throttle background (backlog) sandbox concurrency for a window after the
  // boot gate opens, then release the BullMQ workers. The whole accumulated
  // cron backlog fires at gate-open; without a ramp the burst saturates the
  // pool and times handlers out under the 5s budget (deploy-storm criticals).
  // Interactive HTTP run-tool traffic is unaffected — only background execs ramp.
  const bootRampMs = Number(process.env.SANDBOX_BOOT_RAMP_MS)
  getWorkerPool().beginBootRamp(
    Number.isFinite(bootRampMs) && bootRampMs >= 0 ? bootRampMs : 60_000,
  )
} catch (err) {
  // Non-fatal: the run-tool path still lazy-inits (and retries) on demand.
  rootLogger.error({ err }, "Eager sandbox worker pool init failed — will retry lazily")
}
// Workers app executor: one warning when its variables are set but unusable
// (partial, invalid, or a role other than "all"); every app then runs on QuickJS.
{
  const { warnWorkersSelectionOnce } = await import("~/modules/apps/workers/config")
  warnWorkersSelectionOnce()
}

// Move what the pre-class shared `app-kernel` queue still holds (schedulers,
// delayed jobs) onto the kernel class queues; what is already waiting there is
// drained by name. A singleton (idempotent, never fatal): awaited here when
// this process took the lease at boot, so it runs before the workers below are
// released; otherwise it runs whenever this process later takes the lease.
if (isLeaderEligible(role)) await registerLegacyKernelQueueSingleton()

await haltBootIfShuttingDown()
if (hostsJobs(role)) {
  // Release the (leader-gated) BullMQ workers. Queued jobs (including any backlog
  // from before the restart) still process with full app state: job dispatch
  // waits for the org's apps when it is still registering (infra/jobs/jobs.ts).
  startDeferredJobWorkers()
}

await haltBootIfShuttingDown()
if (servesApi(role)) {
  await createServer(app, {
    wsManager,
    port: env.PORT,
    onUpgrade,
    logPrefix: "Server",
  })
} else {
  // A `worker` serves no API: only liveness (/healthz) and readiness (/readyz).
  const healthApp = new Hono().route("/healthz", healthzRoutes).route("/readyz", readyzRoutes)
  await createServer(healthApp, { port: env.PORT, healthOnly: true, logPrefix: "Health server" })
}
// Start transactional outbox worker last — after durable consumers are
// registered. It drains while this process holds the leader lease.
if (isLeaderEligible(role)) registerOutboxSingleton()
// The leader retries the provider teardowns of removed connections.
if (isLeaderEligible(role)) registerConnectionTeardownSweep()
// The leader removes the Redis entries of processes whose heartbeat lapsed.
if (isLeaderEligible(role)) registerLiveStateSweep()

// A serving process first registers the orgs with live sockets in the cell,
// within LIAISON_READY_WARM_MS: a deploy's reconnecting sockets and their
// people's next requests come from those orgs, and the old processes serve
// them until this one is ready (modules/apps/ready-warm.ts).
if (servesApi(role)) {
  await haltBootIfShuttingDown()
  const { warmLiveOrgsBeforeReady, READY_WARM_MAX_ORGS } = await import("~/modules/apps/ready-warm")
  await warmLiveOrgsBeforeReady({
    liveOrgIds: () => wsManager.live.liveOrgIds(READY_WARM_MAX_ORGS),
    awaitOrg: awaitOrgApps,
    budgetMs: env.LIAISON_READY_WARM_MS,
  })
}

// The role's boot is done: /readyz answers 200. From here an org registry read
// for an org not set up is a missing ensure (modules/apps/org-registry-guard.ts).
await haltBootIfShuttingDown()
const { installOrgRegistryGuard } = await import("~/modules/apps/org-registry-guard")
installOrgRegistryGuard()
// Deleted orgs' runtimes are released every few minutes (org-runtime-release.ts).
const { startOrgRuntimeSweep } = await import("~/modules/apps/org-runtime-release")
startOrgRuntimeSweep()
// Test-only: SIGUSR2 forces a full GC, so a scenario reads a steady RSS
// (tests/e2e/cell/boot-flat.scenario.test.ts). Never installed outside tests.
if (process.env.NODE_ENV === "test") process.on("SIGUSR2", () => Bun.gc(true))
markBootComplete()
// The instant /readyz turns 200, from the process itself: a reader times the
// boot from it, not from how often it polls /readyz (boot-flat.scenario.test.ts).
rootLogger.info({ role, readyAt: Date.now() }, "Process ready")
markBootFinished()
