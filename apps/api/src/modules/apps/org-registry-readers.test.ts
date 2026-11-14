// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T7 static guard: boot registers no org, so every module that reads an
// org-scoped registry (tools, webhook handlers, entities, file parents) must be
// reached only after its org is set up in the process (`awaitOrgApps`). This
// lists every such module with the entry that sets its org up. A new reader
// fails here until it is classified: find its entry points, make sure each one
// awaits `awaitOrgApps(orgId)` (or reads no org's registry), then add a row.
// The runtime net behind it is org-registry-guard.ts (a miss throws in tests).

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const SRC = path.resolve(import.meta.dir, "../..")
const REGISTRY = /\b(toolRegistry|webhookHandlers|entityRegistry|manifestFileParentRegistry)\b/

/** How a reader's org is set up before it reads. */
const REQUEST = "HTTP/WebSocket request: the auth middleware awaits the org's setup first"
const AGENT =
  "agent turn or tool call: runs in a request, job, routine tick or MCP call, each of which sets the org up at its entry"
const JOB =
  "job or event: the job dispatcher, the outbox and the event bus (once) set the org up first"
const MCP = "MCP gateway: the session's authentication sets the org up first"
const SETUP = "registration: fills or replaces the registries while setting an org or an app up"
const ALL_ORGS =
  "instance-wide pass over every registered org (entries()); reads only orgs already set up"
const ENSURES = "awaits awaitOrgApps(orgId) itself before reading"
const WEBHOOK =
  "inbound webhook: app.ts runs setUpOrgForInboundWebhook (awaitOrgApps) before the route"
const CLI = "CLI: registers every org itself (initAppsForOrg) before reading"

const READERS: Record<string, string> = {
  "modules/apps/connections/api/authoring-tools.ts": AGENT,
  // The connection's declared limits: read on a call of an API connection, whose
  // callers (the app's tools in a request or an agent turn, an import job, the
  // CLI) each set the org up first.
  "apps/mcp-manager/routes.ts": REQUEST,
  "cli/search/reindex.ts": CLI,
  "infra/jobs/webhook-inbox-jobs.ts": JOB,
  "infra/jobs/webhook-worker.ts": JOB,
  "modules/agent/context/connected-systems.ts": AGENT,
  "modules/agent/context/context.ts": AGENT,
  // Registers the host's tools under its own measuring org, reads that org, removes it.
  "modules/agent/context/ladder-budget.ts": SETUP,
  // Called by the routine create, update and template enable handlers (skills-routines-tools.ts).
  "modules/agent/routines/flow-scopes.ts": AGENT,
  "modules/agent/routines/routine-incident.ts": JOB,
  "modules/agent/routines/routine-tick-outcome.ts": JOB,
  "modules/agent/runtime/turn-focus.ts": AGENT,
  "modules/agent/scopes/replayed-outside-text.ts": AGENT,
  "modules/agent/scopes/room-resource-history.ts": AGENT,
  "modules/agent/scopes/scope-taint.ts": AGENT,
  "modules/agent/scopes/tool-identifier-redaction.ts": AGENT,
  "modules/agent/tools/company-tools.ts": SETUP,
  "modules/agent/tools/config-tools.ts": AGENT,
  // Registers the kernel connection tools for an org while it is set up.
  "modules/agent/tools/connection-tools.ts": SETUP,
  "modules/agent/tools/import-tools.ts": AGENT,
  "modules/agent/tools/kernel-tools.ts": AGENT,
  "modules/agent/tools/secret-request-tools.ts": AGENT,
  "modules/agent/tools/setup-guide-tools.ts": AGENT,
  "modules/agent/tools/setup-state-tool.ts": AGENT,
  "modules/agent/tools/skills-routines-tools.ts": AGENT,
  "modules/agent/tools/tool-bridge.ts": AGENT,
  "modules/agent/tools/tool-search.ts": AGENT,
  "modules/approvals/approving-reaper.ts": ENSURES,
  "modules/approvals/attention.ts": REQUEST,
  "modules/approvals/authority.ts": REQUEST,
  "modules/approvals/auto-approve.ts": JOB,
  "modules/approvals/cascade.ts": REQUEST,
  "modules/approvals/edit.ts": REQUEST,
  "modules/approvals/poll-output.ts": JOB,
  "modules/approvals/required-step.ts": REQUEST,
  "modules/approvals/routed-reminders.ts": ENSURES,
  "modules/approvals/result-notice.ts": JOB,
  "modules/apps/activation.ts": SETUP,
  "modules/apps/app-registries.ts": SETUP,
  // Reads the tool registry of the app whose run just settled in this process
  // (run-settled.ts), so that org is set up; the refresh job awaits awaitOrgApps.
  "modules/apps/attention-store.ts":
    "run settled: the org of a run this process just made, set up for that run",
  "modules/apps/bulk-agent-tools.ts": AGENT,
  "modules/apps/bulk-dispatch.ts": JOB,
  "modules/apps/catalog-derivations.ts": ALL_ORGS,
  "modules/apps/contract.ts": SETUP,
  // The contract fixture recorders' helper (run by hand): registers the app for the org it
  // records in, then reads its registration back.
  "modules/apps/contract/recording-run.test-helpers.ts": SETUP,
  "modules/apps/execute-tool.ts": AGENT,
  // Names the registry only as a type (the tool definition it validates params against).
  "modules/apps/execute-tool-params.ts": "type only: reads no registry at run time",
  "modules/apps/kernel-bulk.ts": REQUEST,
  "modules/apps/org-app-admin.ts": REQUEST,
  "modules/apps/routes.ts": REQUEST,
  "modules/apps/run-approved-handler.ts": JOB,
  "modules/apps/runtime.ts": SETUP,
  "modules/apps/sandbox/bridge/contracts.ts": AGENT,
  "modules/apps/sandbox/bridge/platform.ts": AGENT,
  "modules/audit/timeline-routes.ts": REQUEST,
  "modules/bug-reports/tool.ts": AGENT,
  // Called by the CLI (ensureAppsForOrg first), agent tools and the secret-request routes.
  "modules/connection-guides/plan.ts":
    "CLI, agent turn or request: each caller sets the org up first",
  "modules/contacts/activity.ts": AGENT,
  "modules/demo/world/commerce-order.ts": ENSURES,
  "modules/demo/worlds/saas/payments/deliver.ts": ENSURES,
  // A source lookup fills the org's registries on a miss (ensureAppsForOrg); the source
  // listing runs from the dashboards routes and tools, each set up first.
  "modules/dashboards/sources.ts":
    "request or agent turn; a lookup miss awaits ensureAppsForOrg itself",
  // Register the kernel dashboard and data tools for an org while it is set up.
  "modules/dashboards/tools.ts": SETUP,
  "modules/dashboards/tables/link-search.ts": ENSURES,
  // A backed table's read tool: read when its rows are listed or written, from the table
  // routes, the table tools and a dashboard block's run, each of which sets the org up first.
  "modules/dashboards/tables/backing.ts":
    "request, agent turn or block run: each caller sets the org up first",
  // Register the kernel table tools for an org while it is set up.
  "modules/dashboards/tables/tools.ts": SETUP,
  // Register (or, with custom apps off, remove) the kernel app builder tools while an org is set up.
  "modules/app-builder/tools.ts": SETUP,
  "modules/data-store/tools.ts": SETUP,
  "modules/documents/print.ts": ENSURES,
  "modules/files/service.ts": REQUEST,
  "modules/mcp-client/projector.ts": SETUP,
  "modules/mcp/node-session-connection.ts": MCP,
  "modules/mcp/tool-call.ts": MCP,
  "modules/mcp/tool-projection.ts": MCP,
  "modules/permissions/scope-catalog.ts": ALL_ORGS,
  "modules/search/searchable-entities.ts": JOB,
  "modules/secret-requests/targets.ts": REQUEST,
  "modules/threads/reference-display.ts": REQUEST,
  "modules/webhooks/handler-run.ts":
    "reads no registry itself: the type of the registration its caller (the webhook route or the inbox replay job) looked up",
  "modules/webhooks/routes.ts": WEBHOOK,
  "modules/agent/context/context-providers.ts": AGENT,
  "modules/agent/runtime/tool-card-store.ts":
    "agent turn (agent-service) or HTTP request (agent and apps routes): each sets the org up at its entry",
  "modules/agent/tools/tool-name-resolve.ts": AGENT,
  "modules/approvals/route-world.ts":
    "approval routing: reached from a tool call, a decision or a Home read, each set up at its entry",
  "modules/mail/send-guard.ts":
    "send check: reached from the mail bridge (tool call) or the approval list and cascade (request)",
  "modules/users/away.ts":
    "away days: reached from set_away (tool call) and the preferences and Home routes (request)",
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "tests") continue
      out.push(...sourceFiles(full))
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full)
    }
  }
  return out
}

describe("org-scoped registry readers (T7)", () => {
  const readers = sourceFiles(SRC)
    .filter((f) => REGISTRY.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
    .sort()

  it("every module that reads an org-scoped registry is classified", () => {
    const unlisted = readers.filter((f) => !(f in READERS))
    expect(unlisted).toEqual([])
  })

  it("no classified module is stale", () => {
    const stale = Object.keys(READERS).filter((f) => !readers.includes(f))
    expect(stale).toEqual([])
  })

  it("each self-ensuring reader, the webhook entry and the CLI do set the org up", () => {
    for (const [file, how] of Object.entries(READERS)) {
      if (how !== ENSURES) continue
      expect(readFileSync(path.join(SRC, file), "utf8")).toMatch(/\bawaitOrgApps\(/)
    }
    const app = readFileSync(path.join(SRC, "app.ts"), "utf8")
    expect(app).toMatch(/\bsetUpOrgForInboundWebhook\(/)
    expect(readFileSync(path.join(SRC, "modules/webhooks/org-setup.ts"), "utf8")).toMatch(
      /\bawaitOrgApps\(/,
    )
    expect(readFileSync(path.join(SRC, "cli/search/reindex.ts"), "utf8")).toMatch(
      /\binitAppsForOrg\(/,
    )
    expect(readFileSync(path.join(SRC, "middleware/auth.ts"), "utf8")).toMatch(/\bawaitOrgApps\(/)
  })
})
