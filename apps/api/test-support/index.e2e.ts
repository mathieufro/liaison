// SPDX-License-Identifier: FSL-1.1-ALv2
// This is the E2E server entrypoint: it sets SSRF-bypass env (LIAISON_*_ALLOW_PRIVATE)
// and installs external-API mocks at module top-level. The production Dockerfile CMD
// never invokes it, but guard explicitly so a misconfigured deploy that points at this
// entrypoint refuses to boot rather than silently disabling SSRF protections and mocking
// external services. MUST be the very first executing statement, before the env writes below.
if (process.env.NODE_ENV === "production") {
  throw new Error("index.e2e.ts (E2E server entrypoint) must not run in production")
}
// E2E scenarios spin up loopback mock servers (mockable web fetch, Gmail HTTP
// fixtures, OAuth callbacks). web-tools' SSRF guard blocks loopback IPs unless
// `LIAISON_WEB_TOOLS_ALLOW_PRIVATE=1` is set — opt in here so the e2e server
// can fetch `http://localhost:<mockPort>` without disabling the production
// guard. Unit `isPrivateUrl` assertions stay genuine because they don't set
// this var.
process.env.LIAISON_WEB_TOOLS_ALLOW_PRIVATE = "1"
// Same rationale for the MCP manager: scenarios connect to an in-process mock
// MCP server on http://127.0.0.1:<port>. The persist + dial SSRF guards block
// loopback unless this is set (see mcpAllowsPrivateTargets). Production never
// sets it, and unit SSRF assertions stay genuine because they don't either.
// NOTE: must NOT use the `LIAISON_MCP_` prefix — env-bootstrap.ts reserves that
// for connection definitions and would fatally mis-parse this flag at boot.
process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP = "1"

import { app } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { applyCatalogDerivations } from "~/db/reconcile-catalog-boot"
import { organizations } from "~/db/schema/kernel"
import { runPhase10Boot } from "~/infra/boot-phase10"
import { initEmailProvider, initSystemEmailProvider } from "~/infra/email"
import { initEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { registerOutboxSingleton } from "~/infra/events/outbox-worker"
import { registerLiveStateSweep, startInstanceHeartbeat } from "~/infra/instance-registry"
import { startEventRoutineSync } from "~/infra/jobs/event-routine-subscriber"
import {
  deferJobWorkersUntilBootComplete,
  hostJobWorkers,
  startDeferredJobWorkers,
} from "~/infra/jobs/jobs"
import { registerKernelJobs } from "~/infra/jobs/kernel-jobs"
import { initWebhookWorker } from "~/infra/jobs/webhook-worker"
import { startLeadership } from "~/infra/leadership"
import { setWsManager, WebSocketManager } from "~/infra/websocket"
import { env } from "~/lib/env"
import { exitWhenParentDies } from "~/lib/parent-death-watchdog"
import { redis } from "~/lib/redis"
import { createServer, type WsData } from "~/lib/server"
import { haltBootIfShuttingDown, installShutdownSignals, markBootFinished } from "~/lib/shutdown"
import { registerProcessShutdownPhases } from "~/lib/shutdown-phases"
import { getDefaultApps, initAppsForOrg } from "~/modules/apps/init"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/rpc-bridge"
import { parseTicketPayload } from "~/modules/auth/ws-ticket"
import {
  boxtalMockHandlesHost,
  makeBoxtalMockFetch,
  shouldInstallBoxtalMock,
} from "./harness/boxtal-mock-fetch"
import { einvoicingMockHandlesHost, makeEinvoicingMockFetch } from "./harness/einvoicing-mock-fetch"
import { gmailFixtureHandlesHost, makeGmailFixtureFetch } from "./harness/gmail-fixture-fetch"
import { makeMetaMockFetch, metaMockHandlesHost } from "./harness/meta-mock-fetch"
import {
  makePennylaneMockFetch,
  pennylaneMockHandlesHost,
  shouldInstallPennylaneMock,
} from "./harness/pennylane-mock-fetch"
import {
  makeShopifyMockFetch,
  shopifyMockHandlesHost,
  shouldInstallShopifyMock,
} from "./harness/shopify-mock-fetch"
import { makeSocialMockFetch, socialMockHandlesHost } from "./harness/social-mock-fetch"
import { makeStripeMockFetch, stripeMockHandlesHost } from "./harness/stripe-mock-fetch"

// Self-terminate if the harness that spawned us dies without running teardown.
// Without this, an aborted e2e run leaves a full API server (HTTP + BullMQ
// workers + a sandbox worker pool that keeps respawning) re-parented to init
// and burning CPU and swap for as long as the machine stays up, starving every
// suite that runs after it. Gated on LIAISON_EXIT_WHEN_ORPHANED, set by
// packages/test-helpers/src/worker-env.ts.
exitWhenParentDies()

// The production shutdown (lib/shutdown.ts), as src/index.ts installs it: a
// SIGTERM (`env.restart()`, teardown) drains, hands the jobs still running back
// to their queue and closes the pools, instead of killing the process outright.
// Without it a job active at the restart (a search rebuild) stayed claimed by
// the dead process: the new boot's requests for the same job were deduplicated
// into it, and nothing ran until BullMQ's stalled check, about a minute later.
// The harness sets short drain budgets (worker-env.ts buildServerSpawnEnv).
installShutdownSignals()

// Memory-leak forensics, E2E entrypoint ONLY. SIGUSR2 dumps RSS plus a Bun heap
// snapshot to LIAISON_E2E_HEAPDUMP_DIR so a long Playwright lane can be sampled
// for growing retainers without restarting the server. Inert unless the dir is
// set, and this file never runs in production (guarded at the top).
if (process.env.LIAISON_E2E_HEAPDUMP_DIR) {
  const dumpDir = process.env.LIAISON_E2E_HEAPDUMP_DIR
  process.on("SIGUSR2", () => {
    void (async () => {
      try {
        const mu = process.memoryUsage()
        let pool: unknown = null
        try {
          const { getSandboxPool } = await import("~/modules/apps/sandbox/pool")
          pool = getSandboxPool().stats()
        } catch {
          /* pool not initialized yet */
        }
        const mb = (n: number) => Math.round(n / 1024 / 1024)
        console.log(
          JSON.stringify({
            memProbe: {
              rssMb: mb(mu.rss),
              heapTotalMb: mb(mu.heapTotal),
              heapUsedMb: mb(mu.heapUsed),
              externalMb: mb(mu.external),
              arrayBuffersMb: mb(mu.arrayBuffers),
              pool,
            },
          }),
        )
        if (process.env.LIAISON_E2E_HEAPSNAPSHOT === "1") {
          const snap = (
            Bun as unknown as { generateHeapSnapshot: (f?: string) => unknown }
          ).generateHeapSnapshot("v8")
          const name = `heap-${Date.now()}-rss${mb(mu.rss)}mb.heapsnapshot`
          await Bun.write(`${dumpDir}/${name}`, JSON.stringify(snap))
          console.log(JSON.stringify({ heapDump: name }))
        }
      } catch (err) {
        console.error("[E2E heapdump] failed:", err)
      }
    })()
  })
}

initEmailProvider()
initSystemEmailProvider()
initEventBus()
await startInstanceHeartbeat({ role: "all", pid: process.pid })
// The process-wide shutdown phases (leadership, drains, job hand-back, pools).
// No internal listener here: the e2e server is one process.
registerProcessShutdownPhases({})

// Phase 18 — install the Boxtal sandbox-fetch mock as the bridge's test
// fetch-impl. It serves canned Boxtal v1/v3 shapes for the Boxtal hostnames and
// DELEGATES TO THE REAL `fetch` for every other host, so the Shopify live-store
// E2E suite (which shares this spawned server) is unaffected. Bare synchronous
// statement near boot — runs before any app handler can issue a sandbox fetch.
// The per-scenario response variants (422/5xx/CONFIRMED-flip) are driven by the
// `_test` Boxtal mock-control route (boxtal-install-routes.ts). The real
// `globalThis.fetch` is captured once for the delegate path; the Boxtal
// hostnames are unreachable in CI, so this never intercepts a call any other
// suite depends on.
// M0.3 — install the mock UNLESS live mode is opted in (BOXTAL_E2E_LIVE=1), in
// which case the bridge falls through to the production fetchWithPinnedHost path
// and reaches the real Boxtal sandbox. Mock remains the CI default. The
// `boxtalE2eLive` log line is an observable proof for the adversarial gate.
// B10 — the Social platform-fetch mock composes WITH the Boxtal mock: the
// bridge fetch-impl is a chain social → boxtal → real, each mock handling its
// own hosts and delegating the rest. The intercepts-host predicate is the union
// of both mocks' host sets (so private/loopback validation is skipped only for
// mocked hosts). When live Boxtal mode is opted in we still install the chain
// rooted at the real Boxtal fetch (the social mock + delegate to real for boxtal
// hosts), so the social mock is always present for the social E2E.
// The Pennylane external-API mock composes into BOTH gate arms, gated
// independently by `shouldInstallPennylaneMock` (PENNYLANE_E2E_LIVE). The
// Pennylane app is a REAL bundled app; this mock stands in only for the external
// `app.pennylane.com` HTTP boundary. Without adding `pennylaneMockHandlesHost`
// to the intercepts-host union, the SSRF/private-host guard would block the read.
// The Shopify Admin-API mock composes into the SAME chain, gated independently by
// `shouldInstallShopifyMock` (SHOPIFY_E2E_LIVE). The Shopify app is a REAL bundled
// app; this mock stands in only for the external `*.myshopify.com` GraphQL
// boundary, so the deep-week-sim analytics scenarios run the real read path
// (typed analytics_query → injection-hardened builder → sandbox bridge → mock)
// deterministically. Without adding `shopifyMockHandlesHost` to the intercepts-host
// union the SSRF/private-host + HTTPS guard would reject the canonical Shopify host.
// The Meta Ads Graph mock composes into the SAME chain, always active (like social).
// It intercepts `graph.facebook.com` so the meta-ads E2E suite can run against
// deterministic fixture campaigns/adsets/ads/insights without real Meta credentials.
// The payments API mock composes into the SAME chain, always active: it answers
// `api.stripe.com` only, refuses a call without the pinned Stripe-Version, and the
// `_test/stripe` routes seed and inspect it (stripe-install-routes.ts).
if (shouldInstallBoxtalMock()) {
  const real = globalThis.fetch.bind(globalThis)
  // The invoicing e-invoicing boundaries (business registry, ECB) answer from loaded fixtures.
  let inner = makeGmailFixtureFetch(makeEinvoicingMockFetch(real))
  if (shouldInstallPennylaneMock()) inner = makePennylaneMockFetch(inner)
  if (shouldInstallShopifyMock()) inner = makeShopifyMockFetch(inner)
  inner = makeStripeMockFetch(inner)
  const chain = makeMetaMockFetch(makeSocialMockFetch(makeBoxtalMockFetch(inner)))
  SandboxBridgeTestAccess.setFetch(chain)
  SandboxBridgeTestAccess.setFetchInterceptsHost(
    (host) =>
      boxtalMockHandlesHost(host) ||
      einvoicingMockHandlesHost(host) ||
      gmailFixtureHandlesHost(host) ||
      socialMockHandlesHost(host) ||
      metaMockHandlesHost(host) ||
      stripeMockHandlesHost(host) ||
      (shouldInstallPennylaneMock() && pennylaneMockHandlesHost(host)) ||
      (shouldInstallShopifyMock() && shopifyMockHandlesHost(host)),
  )
} else {
  console.log(JSON.stringify({ boxtalE2eLive: true }))
  const real = globalThis.fetch.bind(globalThis)
  // Live Boxtal: still mock the social platform hosts (defer boxtal/others to real).
  let inner = makeGmailFixtureFetch(makeEinvoicingMockFetch(real))
  if (shouldInstallPennylaneMock()) inner = makePennylaneMockFetch(inner)
  if (shouldInstallShopifyMock()) inner = makeShopifyMockFetch(inner)
  inner = makeStripeMockFetch(inner)
  const chain = makeMetaMockFetch(makeSocialMockFetch(inner))
  SandboxBridgeTestAccess.setFetch(chain)
  SandboxBridgeTestAccess.setFetchInterceptsHost(
    (host) =>
      einvoicingMockHandlesHost(host) ||
      gmailFixtureHandlesHost(host) ||
      socialMockHandlesHost(host) ||
      metaMockHandlesHost(host) ||
      stripeMockHandlesHost(host) ||
      (shouldInstallPennylaneMock() && pennylaneMockHandlesHost(host)) ||
      (shouldInstallShopifyMock() && shopifyMockHandlesHost(host)),
  )
}

export const wsManager = new WebSocketManager(redis)
setWsManager(wsManager)

registerEventSubscribers(wsManager)
// Event-routine subscriptions follow the cell (event-routine-subscriber.ts): a
// routine changed on another process is announced, and a resync covers a lost one.
await startEventRoutineSync()

// A harness process runs the jobs it drives: declare it a job host. Its workers
// start paused, as the server's do (index.ts), until the boot below has
// registered every handler: a job left in Redis across a restart (a rebuild
// handed back at shutdown) would otherwise be taken at once and fail "No
// handler registered", spending an attempt and waiting out its retry delay.
deferJobWorkersUntilBootComplete()
hostJobWorkers()
await registerKernelJobs()
initWebhookWorker()
// Leadership before the outbox starts (it drains only while this process leads).
// Alone on its Redis prefix, this server takes the lease at once. The test
// timings (ttl 3 s, renew 1 s, poll 250 ms) let a restarted server take it back
// within 3 s instead of 15 s.
await startLeadership({
  role: "all",
  lease: { ttlMs: 3_000, renewMs: 1_000, pollMs: 250 },
})
// The leader removes the Redis entries of processes whose heartbeat lapsed.
registerLiveStateSweep()

// Minimal app descriptors for dependency resolution testing (S27)
const testMissingRequired = {
  name: "test-missing-required",
  version: "1.0.0",
  dependencies: { required: ["nonexistent-app"] },
}

const testOptionalDep = {
  name: "test-optional-dep",
  version: "1.0.0",
  dependencies: { optional: ["nonexistent-app"] },
}

const onUpgrade = async (req: Request): Promise<WsData | null> => {
  const url = new URL(req.url)
  const ticket = url.searchParams.get("ticket")

  if (ticket) {
    const key = `ws-ticket:${ticket}`
    const raw = await redis.getdel(key)
    if (raw) {
      const payload = parseTicketPayload(raw)
      if (payload) {
        return { ...payload, authorized: true }
      }
    }
  }

  return { userId: "", orgId: "", scopes: [], dimensionGrants: {}, authorized: false }
}

const _server = await createServer(app, {
  wsManager,
  port: env.PORT,
  onUpgrade,
  logPrefix: "E2E server",
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function initApps() {
  let bootDeadline: number | undefined
  while (true) {
    // A SIGTERM before the first org exists parks boot here (lib/shutdown.ts).
    await haltBootIfShuttingDown()
    let orgs: { id: string }[] | undefined
    try {
      orgs = await withSystemDb("e2e-poll-orgs", (db) => db.select().from(organizations).limit(1))
    } catch {
      await sleep(100)
      continue // DB not ready yet — keep polling
    }

    if (!orgs || orgs.length === 0) {
      await sleep(100)
      continue
    }

    bootDeadline ??= Date.now() + 30_000
    try {
      const defaultApps = await getDefaultApps()
      await initAppsForOrg(orgs[0].id, defaultApps, {
        extraApps: [testMissingRequired, testOptionalDep] as any[],
      })
      // What the image entrypoint's setup step does before a server starts: the
      // catalog's files SELECT policy and search settings (reconcile-catalog-boot.ts).
      await applyCatalogDerivations()
      // Phase 10: register durable consumers + scheduled jobs.
      await runPhase10Boot()
      // Phase 15: inbound MCP-client kernel module — hydrate slug index,
      // register synthetics, and run the env-bootstrap parser. Wrapped in
      // try/catch (same as the prod boot path in index.ts) so a misconfigured
      // env-bootstrap doesn't bring down the whole E2E suite — the failure
      // surfaces in `worker-*-stderr.log` and the env-bootstrap E2E spec
      // asserts the row exists, which makes the failure observable.
      try {
        const { initMcpClient } = await import("~/modules/mcp-client")
        await initMcpClient()
      } catch (err) {
        console.error("[E2E boot] MCP-client init failed (feature disabled this run):", err)
      }
      // Every handler is registered: release the workers (index.ts does the same).
      startDeferredJobWorkers()
      // Start outbox worker LAST so durable consumers are registered before events flow.
      registerOutboxSingleton()
      markBootFinished()
      console.log(JSON.stringify({ ready: true }))
      return
    } catch (err) {
      if (Date.now() >= bootDeadline) {
        console.error("[E2E boot] failed:", err)
        process.exit(1)
      }
      console.warn("[E2E boot] retrying after transient failure:", err)
      await sleep(250)
    }
  }
}

void initApps()
