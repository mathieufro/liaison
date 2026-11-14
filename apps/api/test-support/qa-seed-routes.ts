// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The QA-seed and install harness routes under /api/_test/*. Mounted by app.ts
// when `qaSeedRoutesEnabled` (NODE_ENV=test, or ENABLE_QA_SEED_ROUTES for the qa/
// browser harness against `bun run dev`). This folder is not part of the
// production image; app.ts resolves this module at run time and refuses to boot
// when the flag is on and the module is absent.
import type { Hono } from "hono"

// biome-ignore lint/suspicious/noExplicitAny: app.ts owns the concrete Hono env type
export async function mountQaSeedRoutes(app: Hono<any>): Promise<void> {
  const [
    { shopifyTestInstallRoutes },
    { invoicingTestInstallRoutes },
    { boxtalTestInstallRoutes },
    { pennylaneTestInstallRoutes },
    { stripeTestInstallRoutes },
    { adsTestInstallRoutes },
    { monitoringTestInstallRoutes },
    { socialTestInstallRoutes },
    { grantScopesTestRoutes },
    { appsTestRoutes },
    { searchReindexTestRoutes },
    { agentScriptTestRoutes },
    { agentToolCallTestRoutes },
    { einvoicingTestRoutes },
    { laneResetTestRoutes },
    { liveStateTestRoutes },
    { shutdownTestRoutes },
    { testEffectToolRoutes },
    { jobEffectsTestRoutes },
    { fanoutTestRoutes },
    { fairnessTestRoutes },
    { seedTestRoutes },
    { appJobRunTestRoutes },
    { workersProbeTestRoutes },
  ] = await Promise.all([
    import("./harness/shopify-install-routes"),
    import("./harness/invoicing-install-routes"),
    import("./harness/boxtal-install-routes"),
    import("./harness/pennylane-install-routes"),
    import("./harness/stripe-install-routes"),
    import("./harness/ads-install-routes"),
    import("./harness/monitoring-install-routes"),
    import("./harness/social-install-routes"),
    import("./harness/grant-scopes-routes"),
    import("./harness/apps-install-routes"),
    import("./harness/search-reindex-routes"),
    import("./harness/agent-script-routes"),
    import("./harness/agent-tool-call-routes"),
    import("./harness/einvoicing-mock-fetch"),
    import("./harness/lane-reset-routes"),
    import("./harness/live-state-routes"),
    import("./harness/shutdown-routes"),
    import("./harness/test-effect-tools"),
    import("./harness/job-effects-routes"),
    import("./harness/fanout-routes"),
    import("./harness/fairness-routes"),
    import("./seed/route"),
    import("./harness/app-job-run-routes"),
    import("./harness/workers-probe-routes"),
  ])
  app.route("/api/_test/shopify", shopifyTestInstallRoutes)
  app.route("/api/_test/invoicing", invoicingTestInstallRoutes)
  // Phase 18 — Boxtal install + sandbox-fetch mock-control routes.
  app.route("/api/_test/boxtal", boxtalTestInstallRoutes)
  // Pennylane install + external-API mock-control routes (deep-week-sim finance).
  app.route("/api/_test/pennylane", pennylaneTestInstallRoutes)
  // Payments connector install + API mock-control routes.
  app.route("/api/_test/stripe", stripeTestInstallRoutes)
  // ads install + meta credentials connection (deep-week-sim ads e2e).
  app.route("/api/_test/ads", adsTestInstallRoutes)
  // monitoring install + incident seed (the incident board has no other driver).
  app.route("/api/_test/monitoring", monitoringTestInstallRoutes)
  // Social "Ground Control" — install-from-source + finding/conversation seeds.
  app.route("/api/_test/social", socialTestInstallRoutes)
  app.route("/api/_test/grants", grantScopesTestRoutes)
  // Phase 16.5 — generic install + reload for the Playwright worker (not
  // Shopify-specific). Future plugin-app e2e tests use these endpoints.
  app.route("/api/_test/apps", appsTestRoutes)
  // One app job for one org, run now and awaited (`/:app/jobs/:job/run`).
  app.route("/api/_test/apps", appJobRunTestRoutes)
  // A Workers run-registry probe for the live isolation checks (`/workers/probe-run`).
  app.route("/api/_test/apps/workers", workersProbeTestRoutes)
  // Synchronous full-reindex so the harness can make search deterministic after
  // seeding (the async indexer pipeline lags under the seed's event backlog).
  app.route("/api/_test/search", searchReindexTestRoutes)
  // P4c-T21b — script the SERVER-side agent turn for a thread (the replacement
  // for the retired panel's client-side SSE stub). Effective only when the
  // server also runs with LIAISON_MODEL_PROVIDER=scripted.
  app.route("/api/_test/agent-script", agentScriptTestRoutes)
  // One tool call as the agent acting for the signed-in user (origin
  // in-app-agent): how a scenario stages a pending approval now that a
  // person's own call never parks one.
  app.route("/api/_test/agent-tool-call", agentToolCallTestRoutes)
  // Invoicing e-invoicing: registry / ECB fixtures and the agent's web search + fetch seams.
  app.route("/api/_test/einvoicing", einvoicingTestRoutes)
  // Shared e2e lanes: drop in-process caches after a data reset between files.
  app.route("/api/_test/lane", laneResetTestRoutes)
  // Cell scenarios: a pending mailbox request in THIS process, answered through another.
  app.route("/api/_test/live", liveStateTestRoutes)
  // Cell scenarios: a request in flight when the process is told to stop.
  app.route("/api/_test/shutdown", shutdownTestRoutes)
  // Turn-resume scenarios: two counted test write tools, registered per process.
  app.route("/api/_test/effect-tools", testEffectToolRoutes)
  // Job-effects scenarios (S11): a job driving one effect door, cut mid-way.
  app.route("/api/_test/job-effects", jobEffectsTestRoutes)
  // Cron fan-out scenario (S15/S16): a probe app job fanned out over every org.
  app.route("/api/_test/fanout", fanoutTestRoutes)
  // Cell scenarios: synthetic floods through the fair job queues (S17).
  app.route("/api/_test/fairness", fairnessTestRoutes)
  // The seed engine's factories by name (seed/route.ts).
  app.route("/api/_test/seed", seedTestRoutes)
}
