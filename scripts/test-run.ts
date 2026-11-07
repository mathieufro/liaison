#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Unified test runner with date-stamped logging.
 *
 * Usage:
 *   bun run test:unit          → logs/YYYY-MM-DD_HH-MM-SS_unit.log
 *   bun run test:integration   → logs/YYYY-MM-DD_HH-MM-SS_integration.log
 *   bun run test:e2e           → logs/YYYY-MM-DD_HH-MM-SS_e2e.log
 *   bun run test:e2e:parallel  → logs/YYYY-MM-DD_HH-MM-SS_e2e-parallel.log
 *   bun run test:playwright    → logs/YYYY-MM-DD_HH-MM-SS_playwright.log
 *   bun run test:worker-env    → logs/YYYY-MM-DD_HH-MM-SS_worker-env.log
 *   bun run test:root          → repo-root script tests (lints, runner, seeds)
 *   bun run test:full          → runs all suites sequentially (unit → int → e2e → parallel → playwright → root)
 *
 * Every run is NAMESPACED (packages/test-helpers/src/test-namespace.ts): its own
 * database liaison_test_<ns> cloned from a migrated template, its own Redis and
 * Meili prefixes, its own port block. <ns> is the checkout's directory name or
 * LIAISON_TEST_NS. Runs in different namespaces never touch each other; up to
 * LIAISON_TEST_SLOTS of them (default 2) run at once, each on its share of RAM.
 */
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import {
  namespaceEnv,
  namespaceForCheckout,
  namespaceMeiliIndexes,
  resolveTestCoordinates,
} from "../packages/test-helpers/src/test-namespace"
import { apiE2eTestFiles } from "./lib/api-e2e-files"
import { computeMemBudget, formatMemBudget } from "./lib/mem-budget"
import { formatMemGuard, killProcessTreeNow, startMemGuard } from "./lib/mem-guard"
import { namedTestFiles, pendingSuiteReason } from "./lib/pending-suites"
import { installRunDeathLogging, shouldContinueFullRun } from "./lib/run-death"
import { acquireNamespaceLock, acquireTestLock, leasePortBlock, slotCount } from "./lib/test-lock"
import { sweepRedisPrefix } from "./lib/test-redis-flush"
import {
  CLEAN_SUBSTRATE_SUITES,
  collectOldTemplates,
  dropTrash,
  prepareNamespaceDb,
  templateHash,
  terminateConnections,
} from "./lib/test-template"

const ROOT = path.resolve(import.meta.dir, "..")
const LOGS = path.join(ROOT, "logs")
// Test env file, passed explicitly to bun-test children via --env-file. Bun's
// implicit `.env.test` auto-load is cwd-relative, and the bun-test suites run
// with cwd=apps/api (which has no .env.test), so the auto-load silently misses
// the repo-root .env.test — leaving DATABASE_URL unset and falling back to the
// env.ts default ("…/liaison"), which then fails with `database "liaison" does
// not exist`. Loading it explicitly makes env resolution robust regardless of
// the child's cwd or bun version. (vitest/playwright load env via mode/config.)
const ENV_FILE = path.join(ROOT, ".env.test")
// Parse positional + optional --test/--file flags.
// Usage: test-run.ts <suite> [--test "<name>"] [--file <path>]... [--mode first-fail|collect-all]
const argv = process.argv.slice(2)
const suite = argv[0]
if (!suite) {
  console.error(
    "Usage: bun scripts/test-run.ts <suite> [--test NAME] [--file PATH] [--mode first-fail|collect-all]",
  )
  console.error(
    "Suites: all, unit, integration, e2e, e2e-parallel, cell, playwright, web-unit, full, worker-env, unsplit-logins, guards, root, desktop, desktop-ui, mobile",
  )
  process.exit(1)
}

let testNameFilter: string | undefined
// --file may repeat: test:gate hands a suite every file a change touches.
const fileFilters: string[] = []
let modeArg: string | undefined
// An argument this loop does not recognise is refused: it used to be dropped,
// so `--file=x`, a bare path, or several paths in one quoted string left the
// file list empty and silently ran the whole suite.
function refuseArgs(message: string): never {
  console.error(message)
  console.error(
    "Usage: bun scripts/test-run.ts <suite> [--test NAME] [--file PATH]... [--mode first-fail|collect-all]",
  )
  process.exit(2)
}
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--test") testNameFilter = argv[++i]
  else if (a === "--file") {
    const value = argv[++i]
    if (value === undefined || value.startsWith("-") || /\s/.test(value)) {
      refuseArgs(
        `--file takes one path (got ${value === undefined ? "nothing" : JSON.stringify(value)}); repeat --file for each file, each as its own argument`,
      )
    }
    fileFilters.push(value)
  } else if (a === "--mode") modeArg = argv[++i]
  else refuseArgs(`Unrecognised argument ${JSON.stringify(a)}`)
}
const fileFilter: string | undefined = fileFilters[0]

const BAIL =
  process.env.LIAISON_TEST_BAIL === "1" ||
  modeArg === "first-fail" ||
  // Single-test runs are always bail-1: there's only one test.
  testNameFilter !== undefined
const DRY_RUN = process.env.LIAISON_TEST_DRY_RUN === "1"
const bailBun = BAIL ? ["--bail=1"] : []
const bailPlaywright = BAIL ? ["--max-failures=1"] : []
const bunTestFlags = testNameFilter ? ["-t", testNameFilter] : []
const vitestTestFlags = testNameFilter ? ["-t", testNameFilter] : []
const playwrightTestFlags = testNameFilter ? ["-g", testNameFilter] : []
const fileArg = fileFilters

// ── Memory budget + test slots + namespace ─────────────────────────────
// Two suite runs at once each sized their parallelism from the whole machine,
// so the sum exceeded physical RAM and the OOM killer ended the run. The slots
// (scripts/lib/test-lock.ts) cap how many runs share the machine; the budget
// gives each one its share. Isolation between those runs is the namespace's
// job, not the lock's.
//
// The composite `full` flow re-enters this script once per suite. Those
// children inherit the parent's slot, namespace and port block through
// LIAISON_TEST_LOCK_HELD rather than queueing behind them, which would
// deadlock the whole run.
//
// The budget is only a PLAN. `scripts/lib/mem-guard.ts` is the enforcement: it
// samples real available memory and the RSS of this process tree every 2 s and
// stops the run when it no longer fits, because the OOM that killed a 16 GB Mac
// came from memory the plan never saw (orphaned servers, a second run, a
// browser). It arms only when we are the lock holder: a child that inherited
// the lock is already inside the parent's tree, so a second guard would only
// race the first to kill the same processes.
//
// A targeted run (one or more --file) gets the smaller single-file reserve
// (2 GiB, not 8): its tree is one lane, and the whole-suite reserve stopped such
// runs (a 5-file unit run at 4.9 GB available) on a 16 GiB Mac that still had a
// third of its memory free. TEST_MEM_RESERVE_MB
// overrides either default.
const SLOTS = slotCount()
const MEM_BUDGET = computeMemBudget(
  undefined,
  undefined,
  process.env,
  SLOTS,
  fileFilters.length >= 1 ? "single-file" : "suite",
)
const MEM_ENV = MEM_BUDGET.env()
// The JIT tiers every suite child runs with, as prod (`bun start`, the
// Dockerfile), the e2e servers and the sandbox workers do (QUICKJS_HOST_JSC_ENV,
// apps/api/src/modules/apps/sandbox/pool.ts): without it the first in-process
// QuickJS run tiers the asyncify WASM up to OMG and the test process gains
// about 1 GB of RSS it never gives back. A value the caller set wins.
const JSC_ENV: Record<string, string> = {
  BUN_JSC_useOMGJIT: process.env.BUN_JSC_useOMGJIT ?? "0",
}
const NS = namespaceForCheckout(ROOT)
let memGuard: { setLogDir(dir: string): void; stop(): void } | null = null
// The slot this run holds, so a run that cannot start (database, Redis or Meili
// down) hands it back the moment preflight fails, not when the process unwinds.
let slotLock: { release(): void } | null = null
function failPreflight(message: string): never {
  slotLock?.release()
  console.error(message)
  process.exit(1)
}
// True once the memory guard decided to stop the run. The composite loop below
// checks it before starting another suite: killing the tree resolves the
// `await child.exited` it is sitting in, and without this flag it used to start
// the NEXT suite while the guard was still inside its grace period. That child
// then outlived the runner and kept writing to the run log, which is what made
// a dead runner look like a stall.
let guardTripped = false
// The in-flight suite child, so a dying runner can take it with it.
let currentChild: { kill(signal?: number | NodeJS.Signals): void } | null = null
let currentChildPid: number | null = null
const reportDeath = installRunDeathLogging({
  label: `test-run.ts ${suite}`,
  // The whole tree, not just the child: a dying runner that killed only its
  // direct child left a `bunx playwright test` child's own workers, and the API
  // servers those had spawned, running for 15 minutes.
  killCurrentChild: () => {
    if (currentChildPid !== null) killProcessTreeNow(currentChildPid)
    currentChild?.kill(9)
  },
})
let portBase = process.env.LIAISON_TEST_PORT_BASE
if (!DRY_RUN) {
  // Namespace first: a second run of the same checkout waits here without
  // holding a slot another namespace could use. A parent that already holds
  // it (the `full` flow, with-test-lock.ts) says so with LIAISON_TEST_NS_HELD
  // and hands the leased port block down in LIAISON_TEST_PORT_BASE.
  if (process.env.LIAISON_TEST_NS_HELD !== "1" || !portBase) {
    await acquireNamespaceLock(NS, { cmd: `test-run.ts ${suite}` })
    portBase = String(leasePortBlock(NS, { cmd: `test-run.ts ${suite}` }).base)
  }
  if (process.env.LIAISON_TEST_LOCK_HELD !== "1") {
    slotLock = await acquireTestLock({ cmd: `test-run.ts ${suite}`, ns: NS })
    memGuard = startMemGuard({
      budgetMb: MEM_BUDGET.budgetMb,
      reserveMb: MEM_BUDGET.reserveMb,
      logDir: LOGS,
      label: `test-run.ts ${suite}`,
      onTrip: (reason) => {
        guardTripped = true
        // Say it in the log and take the in flight child with us: the guard is
        // about to kill the tree and exit, and a surviving child would keep
        // writing to this log as if the run were still going.
        reportDeath({ kind: "memory-guard", detail: `trip reason ${reason}` })
      },
    })
  }
  console.log(formatMemBudget(MEM_BUDGET))
  if (memGuard) console.log(formatMemGuard(MEM_BUDGET.budgetMb, MEM_BUDGET.reserveMb))
}
// Every coordinate this run and its children use. A child of `full` inherits
// the namespace and the leased port block from the environment.
const COORDS = resolveTestCoordinates({
  ...process.env,
  LIAISON_TEST_NS: NS,
  LIAISON_TEST_PORT_BASE: portBase,
})
const NS_ENV = namespaceEnv(COORDS)
if (!DRY_RUN) {
  console.log(
    `namespace ${NS}: db ${COORDS.dbName}, redis ${COORDS.redisPrefix}*, meili ${COORDS.meiliPrefix}*, ports ${COORDS.portBase}-${COORDS.portBase + 999}, ${SLOTS} slot(s)`,
  )
  console.log("")
}

/**
 * Brings this namespace's database up to the current migrations: a fresh clone
 * of the template when `fresh`, else the existing copy when it was cloned from
 * the current template. Exits the run when it cannot.
 */
async function prepareDb(fresh: boolean): Promise<void> {
  try {
    const r = await prepareNamespaceDb({ root: ROOT, coords: COORDS, fresh })
    console.log(
      `  ${COORDS.dbName}: ${r.action} from ${r.template}${r.templateBuilt ? " (template built)" : ""} in ${(r.ms / 1000).toFixed(2)}s`,
    )
  } catch (err) {
    failPreflight(
      `  could not prepare ${COORDS.dbName}: ${err instanceof Error ? err.message : err}`,
    )
  }
}

/** Old copies of this namespace's database and unused templates, dropped off the critical path. */
function cleanupInBackground(): Promise<void> {
  return (async () => {
    try {
      await dropTrash(COORDS, COORDS.dbName)
      await collectOldTemplates({ coords: COORDS, keepHash: templateHash(ROOT) })
    } catch (err) {
      console.warn(`  substrate cleanup skipped: ${err instanceof Error ? err.message : err}`)
    }
  })()
}

// The bun half of apps/desktop, globbed rather than listed. A hand written
// list meant a new apps/desktop/*.test.ts ran nowhere and nothing said so, and
// the file that would have caught it was itself one of the files nobody added.
// src/** is deliberately not here: those are Solid components and they are the
// `desktop-ui` suite's, on vitest. `ci` is here because the release scripts
// live there, and a test written next to the script it pins is the natural
// place to write it: with that directory out of the list such a file runs in
// no suite at all, the hand written list's failure one directory along. The
// ONE exception is src/tests/e2e, which
// holds the overlay's live scenario: it is a bun file (no JSX, a real sidecar
// and a real server), and vitest excludes that directory for the same reason.
function desktopBunTests(): string[] {
  const base = path.join(ROOT, "apps/desktop")
  const found: string[] = []
  for (const dir of [".", "ci", "sidecar", "src/tests/e2e"]) {
    const absolute = path.join(base, dir)
    if (!existsSync(absolute)) continue
    for (const name of readdirSync(absolute)) {
      if (!name.endsWith(".test.ts")) continue
      found.push(dir === "." ? name : `${dir}/${name}`)
    }
  }
  return found.sort()
}

// The api e2e suites' provider keys. A scenario that drives a real model
// spends money on every run, so the default run carries the same fixed
// placeholder keys as every other suite (apps/api/src/tests/test-env-defaults.ts)
// and the live scenarios skip (apps/api/src/tests/e2e/helpers/live-llm.ts).
// LIAISON_E2E_LIVE_LLM=1 opts in: the machine's real keys reach the test
// processes and the servers they boot, and the live scenarios run. Set here
// rather than left to the preload because the e2e-parallel runner and the API
// servers it boots never load that preload, and would otherwise forward the
// real keys `.env.test` carries.
const E2E_PROVIDER_KEY_VARS = [
  "LIAISON_ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "EXA_API_KEY",
] as const
function e2eProviderKeyEnv(): Record<string, string> {
  if (process.env.LIAISON_E2E_LIVE_LLM === "1") {
    return { LIAISON_TEST_REAL_PROVIDER_KEYS: "1", LIAISON_E2E_LIVE_LLM: "1" }
  }
  const env: Record<string, string> = {}
  for (const name of E2E_PROVIDER_KEY_VARS) {
    env[name] = `test-placeholder-${name.toLowerCase().replaceAll("_", "-")}`
  }
  return env
}

const SUITES: Record<string, { cmd: string[]; cwd: string; env?: Record<string, string> }> = {
  all: {
    cmd: ["bun", "test", ...bunTestFlags, ...fileArg],
    cwd: path.join(ROOT, "apps/api"),
  },
  // Unfiltered, the unit suite runs SHARDED (scripts/test-unit-parallel.ts):
  // batches of files per bun process, spread over shard databases cloned from this
  // namespace's template. A --file or --test run stays one plain `bun test`.
  unit: {
    cmd: [
      ...(fileFilter || testNameFilter
        ? ["bun", "test", ...bailBun, ...bunTestFlags]
        : [
            "bun",
            "run",
            path.join(ROOT, "scripts/test-unit-parallel.ts"),
            ...(BAIL ? ["--bail"] : []),
            "--",
          ]),
      ...(fileFilter
        ? fileArg
        : [
            "src/modules",
            "src/infra",
            "src/middleware",
            "src/lib",
            "src/db",
            "src/apps",
            "src/services",
            "src/cli",
            // The test harness (QA seed routes, external-API mocks, test-only
            // apps), kept outside src so the production image never carries it.
            "test-support",
          ]),
    ],
    cwd: path.join(ROOT, "apps/api"),
    // A privileged-pool acquisition made while the same caller already holds a
    // privileged slot deadlocks a full pool in production (db/privileged.ts):
    // here it throws, so a code path that nests fails its tests.
    env: { NESTED_PRIVILEGED_STRICT: "1" },
  },
  "web-unit": {
    cmd: ["bunx", "--bun", "vitest", "run", ...bailBun, ...vitestTestFlags, ...fileArg],
    cwd: path.join(ROOT, "apps/web"),
  },
  integration: {
    // Runs all cross-module integration tests in src/tests/ (excluding e2e/).
    // auth-service.test.ts requires exclusive DB state (bootstrapRegister needs
    // zero orgs) — serialized naturally since bun test runs sequentially within a dir.
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/tests/auth-service.test.ts",
            "src/tests/auth-login-error.test.ts",
            "src/tests/app-contract.test.ts",
            "src/tests/contacts.test.ts",
            "src/tests/db-import-enforcement.test.ts",
            // Host binding on every credential path, and OAuth through a central
            // redirect host (managed edition, org hosts): app + database.
            "src/tests/host-binding-matrix.test.ts",
            // Org-private custom apps (managed edition): the hostile-tenant boundary.
            "src/tests/integration/custom-apps-tenant-boundary.test.ts",
            "src/tests/oauth-redirect-base.test.ts",
            // Repo-wide grep: no agent-specific node templates or features.
            "src/tests/no-agent-specific-node.test.ts",
            // Every tool that hands the agent third-party text marks the turn,
            // and every ungated outward tool is listed. Pure manifest reads.
            "src/tests/taint-source-manifests.test.ts",
            "src/tests/event-bus.test.ts",
            "src/tests/event-subscribers.test.ts",
            "src/tests/full-integration.test.ts",
            "src/tests/jobs-integration.test.ts",
            // P8-FX21 (A45): the calls connector's webhook ingestion against
            // the real bridge and Postgres. It was in no suite while
            // knowledge:create gated for the webhook handler actor and every
            // segment answered 503; the gate no longer fires for a connector
            // ingestion, so the file belongs where the rest of the DB-backed
            // integration tests run.
            "src/tests/integration/calls-webhook.integration.test.ts",
            // A gated kernel tool is decided by whoever holds its own scope, through the
            // real chat seam and decide path.
            "src/tests/integration/kernel-approval-deciding-scope.test.ts",
            "src/tests/integration/tickets-primitives.test.ts",
            "src/tests/integration/tickets.conversion.dependency-check.test.ts",
            "src/tests/integration/mail-tickets-conversion.test.ts",
            // Mailbox encryption (Phase 1, Task 1.7). mail-sync and mail-api
            // existed on disk and were listed by no suite, so their coverage
            // never ran in CI. The four that follow are created by later
            // phases: until then `bun test` fails loudly on the missing path,
            // which is the red state the creating phase owns.
            "src/tests/integration/mail-sync.test.ts",
            "src/tests/integration/mail-api.test.ts",
            // A send from a mailbox with no stored credentials answers 422, both paths.
            "src/tests/integration/mail-send-credentials-missing.test.ts",
            "src/tests/integration/mail-encrypted-conversation-state.test.ts",
            "src/tests/integration/mail-agent-search.test.ts",
            "src/tests/integration/mail-conversation-search.test.ts",
            "src/tests/integration/mail-backfill.test.ts",
            // The Shopify fixture provider driven through the REAL app runtime:
            // home_load, orders_search, products_search and boxtal's
            // to_prepare_list all answered from fixtures for a demo org, and the
            // request still put on the wire for every other org.
            "src/tests/integration/demo-shopify-runtime.test.ts",
            "src/tests/integration/mailbox-client-jobs.test.ts",
            // Landed with the zero-access mailbox work but listed by no suite,
            // so the migration-path and fresh-profile-restore oracles ran
            // nowhere. scripts/test-run.suites.test.ts was already red on both.
            "src/tests/integration/mailbox-migrations-from-0038.test.ts",
            // Migrations run once under the lease, on fresh empty databases:
            // two concurrent runners, a crashed holder, a failing renewal.
            "src/tests/integration/migration-lease.test.ts",
            // Apps live without a restart (install, upgrade, uninstall) across two
            // real server processes with their own install roots.
            "src/tests/integration/live-install.integration.test.ts",
            "src/tests/integration/mailbox-fresh-profile-restore.test.ts",
            "src/tests/integration/shopify-order-event-contract.test.ts",
            "src/tests/integration/config-cli-idempotency.test.ts",
            "src/tests/integration/config-cli-hub-path.test.ts",
            "src/tests/integration/config-cli-no-secret.test.ts",
            // config apply drift safety and config pull (#637), a sandboxed app
            // attaching its own file to a ticket (#636) and tickets:create
            // idempotency (#641): each landed listed by no suite.
            "src/tests/integration/config-drift.test.ts",
            "src/tests/integration/cross-app-file-attach.integration.test.ts",
            "src/tests/integration/tickets-create-idempotency.integration.test.ts",
            // Mention turns read with the asker's roles (#208); it landed listed by no suite.
            "src/tests/integration/mention-turn-roles.test.ts",
            // The agent opens a tab: every record kind, under the real row policies.
            "src/tests/integration/open-any-tab.test.ts",
            // 2a/2b's chat-turn integration tests landed listed by no suite, so
            // the scope-taint and effective-scope oracles ran nowhere.
            // scripts/test-run.suites.test.ts was red on all three.
            "src/tests/integration/effective-scope-chat.test.ts",
            "src/tests/integration/manifest-readonly-taint-chat.test.ts",
            "src/tests/integration/shopify-readonly-taint-chat.test.ts",
            // The declared-sink and gated-write audience oracles of scope taint.
            "src/tests/integration/sink-read-scope-taint.test.ts",
            "src/tests/integration/scope-taint-reads-and-audience.test.ts",
            // The one audience rule for every write on a tainted turn (rules 5 to
            // 7), a contacts write parking like any gated write, the acting-user-only
            // reader of notify_user, and the contact group tools: all driven through
            // the real chat seam, no module replaced.
            "src/tests/integration/scope-taint-audience-readers.test.ts",
            "src/tests/integration/contacts-write-taint.test.ts",
            "src/tests/integration/notify-user-self-reader-taint.test.ts",
            "src/tests/integration/contact-groups-agent-tools.test.ts",
            // Agent tools over documents, contact addresses and mail conversation
            // search, and the audience of a self-resource approval.
            "src/tests/integration/self-resource-approval-audience.test.ts",
            "src/tests/integration/document-agent-tools.test.ts",
            "src/tests/integration/contact-addresses-agent-tools.test.ts",
            "src/tests/integration/mail-conversation-search.test.ts",
            // A contact's discussion: the write gate on contacts and the agent's post there.
            "src/tests/integration/contacts-write-gate.test.ts",
            "src/tests/integration/contact-discussion-agent-post.test.ts",
            // Delete my account (S19, S20): code-only step-up, last admin,
            // approvals, push tokens, and the demo reviewer's displayed code.
            "src/tests/integration/account-delete.integration.test.ts",
            "src/tests/integration/answering-thread-taint.test.ts",
            // A wrong step-up proof is 422 on TOTP setup/disable and the
            // mailbox reset; a 401 read as a dead session to the web client.
            "src/tests/integration/step-up-wrong-proof.integration.test.ts",
            // Kernel tools replayed per org from one template, and an org runtime
            // released then set up again: process registries against a real org row.
            "src/tests/integration/kernel-tools-template.test.ts",
            "src/tests/integration/org-runtime-release.test.ts",
            "src/tests/agent-visible.test.ts",
            "src/tests/manifest-mail-delta.test.ts",
            "src/tests/manifest-tickets-delta.test.ts",
          ]),
    ],
    cwd: path.join(ROOT, "apps/api"),
    // Nested privileged acquisitions throw here too (see the unit suite).
    env: { NESTED_PRIVILEGED_STRICT: "1" },
  },
  // P8-FX7 (D7): the files under src/tests and src/tests/integration that no
  // suite listed. Their old exemption said they needed "a live substrate";
  // every one of them was then run against exactly the substrate the
  // `integration` suite provisions, and every one was green. They get a suite
  // of their own rather than a seat in `integration` because that suite is ONE
  // bun process: run together with it, four of its job-runtime and sandbox
  // cases fail on shared BullMQ registration state that no file here or there
  // owns. Two processes cost seconds; diagnosing that shared state is its own
  // piece of work, and until it is done a shared process would land a red
  // suite rather than the coverage these files are here for.
  "integration-extra": {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/tests/agent-integration.test.ts",
            "src/tests/agent-memory-taint-context.test.ts",
            "src/tests/app-sandbox.test.ts",
            "src/tests/db-schema-billing-neutral.test.ts",
            "src/tests/hij-reachability.test.ts",
            "src/tests/knowledge-agent-loop.integration.test.ts",
            "src/tests/mail-accounts.test.ts",
            "src/tests/mcp-critical-scenarios.test.ts",
            "src/tests/parallel-isolation.test.ts",
            "src/tests/permission-propagation.test.ts",
            "src/tests/permission-version-bump.test.ts",
            "src/tests/route-test-setup-lock.test.ts",
            "src/tests/sandbox-integration.test.ts",
            "src/tests/sandbox-worker-integration.test.ts",
            "src/tests/timeout-middleware.test.ts",
            "src/tests/integration/app-guides.test.ts",
            "src/tests/integration/attention-digest.test.ts",
            "src/tests/integration/attention-digest-resend.test.ts",
            "src/tests/integration/attention.feed.integration.test.ts",
            "src/tests/integration/attention.mark-read-bulk.integration.test.ts",
            "src/tests/integration/contacts-agent-merge.test.ts",
            "src/tests/integration/contacts-merge-taint-chat.test.ts",
            "src/tests/integration/private-contacts-security.test.ts",
            "src/tests/integration/instagram-token-refresh.test.ts",
            "src/tests/integration/jobs-retention-drain.integration.test.ts",
            "src/tests/integration/mail-agent-reply.test.ts",
            // Drives mail-api and mail-sync in a CHILD bun process behind a
            // narrow app_mail.conversations, which is what proves those two
            // files own the schema they assert. It lives here rather than in
            // `integration` because the child runs exactly the files that
            // suite lists: same process, they would fight over the fixture.
            "src/tests/integration/mail-fixture-registration-ownership.test.ts",
            // Kills a CHILD bun mid-fixture to leave an orphan stash behind,
            // which is the state the take-over must recognise. Same reason as
            // the file above for living here: the child is its own process.
            "src/tests/integration/fixture-stash-orphan-recovery.test.ts",
            // Drives contacts/service.test.ts in a CHILD bun behind a
            // registered-shape app_invoicing. It used to sit in
            // src/modules/contacts, which the unit suite selects whole, so the
            // parent process ran the very file the child was driving.
            "src/tests/integration/last-activity-fixture-ownership.test.ts",
            // Drives contacts/merge.test.ts in a CHILD bun (plus a probe file) behind
            // a registered-shape app_invoicing. It used to sit in src/modules/contacts,
            // which the unit suite selects whole, so the parent process ran the very
            // file the child was driving.
            "src/tests/integration/merge-registered-invoicing-survives.test.ts",
            // Drives contacts/merge.test.ts in a CHILD bun behind a foreign
            // app_mail.conversations. Same reason as the file above for living here.
            "src/tests/integration/merge-fixture-app-mail-ownership.test.ts",
            "src/tests/integration/mcp-integration.test.ts",
            "src/tests/integration/meta-instagram-oauth.test.ts",
            "src/tests/integration/migration-approval-idempotency.test.ts",
            "src/tests/integration/mount-order.test.ts",
            "src/tests/integration/outbox-ws-delivery.integration.test.ts",
            "src/tests/integration/pennylane-connector.integration.test.ts",
            "src/tests/integration/invoicing-order-reissue-atomic.test.ts",
            // Legal originals: kernel immutable flag (write-once rows, retention on rows and files).
            "src/tests/integration/invoicing-legal-original-retention.test.ts",
            // Factur-X legal original at issue through the real sandbox and kernel renderer.
            "src/tests/integration/invoicing-facturx-issue.test.ts",
            // The issue date and number year at instants set on the host clock, through the sandbox.
            "src/tests/integration/invoicing-issue-date.test.ts",
            // Minor-unit money through the real sandbox: refused before parking, card equals issue.
            "src/tests/integration/invoicing-minor-amounts.test.ts",
            // E-invoice send through the einvoicing-pa@1 provider contract (Pennylane fake behind
            // the egress override): approvals, two-phase transmission, webhooks, fault windows.
            "src/tests/integration/einvoicing-send.test.ts",
            // Received supplier e-invoices through the same contract: arrival webhook → mirror,
            // first-hop-only file downloads, unlisted-hop refusal, gated refusal never auto-approved.
            "src/tests/integration/einvoicing-receive.test.ts",
            "src/tests/integration/invoicing-einvoice-gate-sites.test.ts",
            "src/tests/integration/invoicing-identity-tools.test.ts",
            "src/tests/integration/invoicing-identity-backfill.test.ts",
            "src/tests/integration/invoicing-imported-original.test.ts",
            "src/tests/integration/shopify-invoicing-po-number-seam.test.ts",
            "src/tests/integration/shopify-invoicing-refund-seam.test.ts",
            "src/tests/integration/shopify-oauth-callback.test.ts",
            // An instance-provided Shopify app: OAuth and webhook HMAC with its client.
            "src/tests/integration/shopify-instance-client.test.ts",
            // Accounts keep the OAuth client that minted them (refresh, webhooks, reconnect).
            "src/tests/integration/oauth-minting-client.test.ts",
            // A protected (opt-in) OAuth scope is requested only when the org opted in.
            "src/tests/integration/oauth-protected-scopes.test.ts",
            "src/tests/integration/social-assets-reconcile.test.ts",
            // Meta webhooks reach the polled rows; one reply approval per finding.
            "src/tests/integration/social-webhook-and-reply.test.ts",
            // A request_secret card is posted in the turn, or carried by the approval.
            "src/tests/integration/request-secret-approved-card.test.ts",
            // agents_ask: the asked agent always answers in the thread, in its own name.
            "src/tests/integration/agent-ask-thread-reply.test.ts",
          ]),
    ],
    cwd: path.join(ROOT, "apps/api"),
  },
  // P8-FX10: the tests that talk to a REAL third party over the network with a
  // REAL credential. `real-gitlab.live.test.ts` sat in src/apps, which the
  // `unit` suite selects whole, so the day its read-only token expired the unit
  // gate went red on a credential rather than on the code: HTTP 401
  // invalid_token, 9082 tests held hostage by one PAT. The file still gates
  // itself on GITLAB_TEST_TOKEN and still skips when the token is unset, but it
  // no longer decides whether the unit suite passes. This suite is deliberately
  // NOT in FULL_ORDER: it is run by hand, by whoever has current credentials
  // and wants the real round trip. `agent-deferred-tools.live.test.ts` moved
  // here with it, out of src/services, for the same reason: it drives a real
  // Gemini model over a real key, and a spend cap or a rotated key is not a
  // verdict on the code the unit suite covers.
  live: {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter ? fileArg : ["src/tests/live"]),
    ],
    cwd: path.join(ROOT, "apps/api"),
    // Keep the machine's real provider keys (the test preload replaces them
    // with placeholders everywhere else).
    env: { LIAISON_TEST_REAL_PROVIDER_KEYS: "1" },
  },
  // P8-FX7 (D7), P8-FX9 (D8): the files that call `mock.module` on a kernel
  // module. The fourth (rpc-bridge.security-b1) sat under src/modules and so
  // ran in the flat `unit` process, where its jobs stub outlived it for every
  // later sandbox file; it moved here out of that directory, since the unit
  // suite selects whole directories and cannot exclude one file.
  // `mock.module` is PROCESS-wide and survives the file that wrote it (putting
  // the real module back in afterAll does not un-mock it for a file bun has
  // already imported), so these replace `~/infra/jobs/jobs` for whatever else
  // shares their process: with them in the same suite, four job-runtime and
  // sandbox cases elsewhere passed or failed on bun's file order. They run
  // together, alone, until the recorder they need exists as a seam rather than
  // as a module replacement.
  "integration-mocked": {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/tests/event-routine-auto-approve.integration.test.ts",
            "src/tests/integration/event-routine-authoring.integration.test.ts",
            "src/tests/integration/event-routine-subscriber.test.ts",
            // Event routine owner gate and sender filter, and the production
            // routine tick (agents_ask, Morning brief): each replaces
            // `~/infra/jobs/jobs` with mock.module, so they share this process.
            "src/tests/integration/event-routine-owner-gate.test.ts",
            "src/tests/integration/routine-event-filter-persistence.test.ts",
            "src/tests/integration/routine-tick-agents-ask.test.ts",
            "src/tests/integration/morning-brief-template.test.ts",
            "src/tests/integration/rpc-bridge.security-b1.test.ts",
            "src/tests/integration/sandbox-bridge-savepoints.test.ts",
          ]),
    ],
    cwd: path.join(ROOT, "apps/api"),
  },
  e2e: {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      // Every e2e file but the cell suite's (scripts/lib/api-e2e-files.ts): the
      // bare directory would walk into src/tests/e2e/cell.
      ...(fileFilter
        ? fileArg
        : apiE2eTestFiles(path.join(ROOT, "apps/api/src/tests/e2e")).map(
            (f) => `src/tests/e2e/${f}`,
          )),
    ],
    cwd: path.join(ROOT, "apps/api"),
    env: e2eProviderKeyEnv(),
  },
  // The multi-process scenarios: each file boots a cell of real `src/index.ts`
  // processes (createRoleCell, typically 2 `api` + 1 `worker`), so about three
  // bun servers per file. bun runs the files one after another; the e2e and
  // e2e-parallel suites never take them. Run with TEST_MEM_RESERVE_MB set on a
  // loaded machine. The cell clients' own test boots a one-process cell.
  cell: {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/tests/e2e/cell",
            path.join(ROOT, "packages/test-helpers/src/cell-clients.test.ts"),
          ]),
    ],
    cwd: path.join(ROOT, "apps/api"),
    env: e2eProviderKeyEnv(),
  },
  "e2e-parallel": {
    // Worker count comes from the computed memory budget (TEST_E2E_WORKERS),
    // which test-e2e-parallel.ts reads itself.
    cmd: ["bun", "run", "scripts/test-e2e-parallel.ts", ...fileArg],
    cwd: ROOT,
    env: e2eProviderKeyEnv(),
  },
  playwright: {
    cmd: [
      "bunx",
      "--bun",
      "playwright",
      "test",
      ...bailPlaywright,
      ...playwrightTestFlags,
      ...fileArg,
    ],
    cwd: path.join(ROOT, "apps/web"),
  },
  // Back-compat alias
  "e2e-web": {
    cmd: ["bunx", "--bun", "playwright", "test"],
    cwd: path.join(ROOT, "apps/web"),
  },
  "worker-env": {
    // vite.test.ts rides along here: it covers the dev-server supervisor's
    // orphan guarantees (the same harness-lifecycle concern worker-env.test.ts
    // covers for the API server) and is in no other suite's cwd.
    // server-memory-bound.test.ts pins the `--smol` flag the spawned e2e API
    // server runs under (worker-env.ts serverBunFlags) for the same reason.
    // test-db-target.test.ts: every reset, drift and preflight path targets the
    // database the run's URL vars name and refuses any other.
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/worker-env.test.ts",
            // The data snapshot / restore a shared e2e lane resets files with.
            "src/worker-snapshot.test.ts",
            "src/vite.test.ts",
            "src/server-memory-bound.test.ts",
            // The run namespace every coordinate (database, prefixes, ports) comes from.
            "src/test-namespace.test.ts",
            "src/test-db-target.test.ts",
            // The lane attach handle (TestWorld) against a worker server.
            "src/test-world.test.ts",
          ]),
    ],
    cwd: path.join(ROOT, "packages/test-helpers"),
  },
  // The elevation helpers (privilegedFrom, withElevatableRlsFrom, asAdmin) and
  // the SECURITY DEFINER functions pick their path from the transaction's login.
  // Every other suite runs split (request transactions on liaison_request); this
  // one runs the files that prove those paths with ONE login for every pool, as a
  // deployment without DATABASE_REQUEST_PASSWORD does.
  "unsplit-logins": {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/db/elevation-both-logins.test.ts",
            "src/modules/threads/message-acting-agent-tx.integration.test.ts",
          ]),
    ],
    cwd: path.join(ROOT, "apps/api"),
    env: { LIAISON_TEST_UNSPLIT_LOGINS: "1" },
  },
  // packages/shared unit tests (pure — approval authority, refs, reasoning,
  // types). Previously in NO suite: the workspace's test files under
  // packages/shared were discovered by nothing, so the shared approval
  // authority module's contract would have been unenforced in CI.
  shared: {
    cmd: ["bun", "test", ...bailBun, ...bunTestFlags, ...fileArg],
    cwd: path.join(ROOT, "packages/shared"),
  },
  // P8-FX7 (D7): the five workspace packages whose tests ran in NO suite.
  // Each was exempted under a blanket "needs a substrate" sentence and each
  // runs green with nothing but the repo: 189 tests across 13 files. They run
  // from the repo root in one process rather than as five one-line suites,
  // because nothing in them needs a cwd of its own. `test-helpers` is not
  // here: the `worker-env` suite already runs in that package.
  "workspace-packages": {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            path.join(ROOT, "packages/api-connector-core"),
            path.join(ROOT, "packages/app-sdk"),
            path.join(ROOT, "packages/app-ui"),
            path.join(ROOT, "packages/control-plane-contract"),
            path.join(ROOT, "packages/db-core"),
            path.join(ROOT, "packages/host-sdk"),
          ]),
    ],
    cwd: ROOT,
  },
  // packages/mailbox-crypto unit tests (isomorphic crypto for zero-access
  // personal mailboxes). Modelled on the `shared` entry above: a workspace
  // package that no other suite reaches needs its own entry plus a FULL_ORDER
  // entry, or its tests are decoration.
  "mailbox-crypto": {
    cmd: ["bun", "test", ...bailBun, ...bunTestFlags, ...fileArg],
    cwd: path.join(ROOT, "packages/mailbox-crypto"),
  },
  // THE REPO-ROOT GUARDS, as a suite a gate can actually run.
  //
  // Each of these fails a DEPLOY or a shipped string rather than a feature: the
  // API image's workspace list against the root's (a workspace added to one and
  // not the other only breaks inside a deploy's docker build), the no-Node gate
  // for the desktop stack, the repo-wide copy sweep, and the suite-routing lint
  // that keeps a test file from being decoration. They used to sit in `root`,
  // which no gate runs: the Dockerfile guard was red for a whole slice and
  // nobody saw it. They are pure file reads plus one small spawn, so the suite
  // costs seconds and can be run on any change.
  guards: {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "scripts/dockerfile-workspaces.test.ts",
            // Image bases and the BuildKit frontend pinned by digest. Pure file reads.
            "scripts/dockerfile-pins.test.ts",
            "scripts/dockerfile-cli-shim.test.ts",
            "scripts/check-desktop-no-node.test.ts",
            "scripts/lint-copy-dashes.repo.test.ts",
            "scripts/test-run.suites.test.ts",
            // Test files are named after behaviour, never a phase or web-NN number.
            "scripts/test-file-names.test.ts",
            // Test scaffolding stays out of the production API tree.
            "scripts/api-test-support-boundary.test.ts",
            // Compose DB pools fit max_connections through a rolling deploy's overlap. Pure file reads.
            "scripts/compose-db-connection-budget.test.ts",
            // The iOS, Android and desktop icons are the favicon mark: every
            // rendered PNG decoded and sampled. Pure file reads.
            "scripts/render-app-icons.test.ts",
            // The local permission modes agree across the desktop sidecar,
            // the Rust shell and the API start schema. Pure file reads.
            "scripts/permission-modes-parity.test.ts",
            // CI supply chain: actions pinned by SHA, least-privilege
            // permissions, no remote script piped into a shell. Pure file reads.
            "scripts/check-workflow-hardening.test.ts",
            // Every testid a guided tour names exists in the web source
            // (packages/shared/src/tours). Pure file reads.
            "scripts/tour-anchors-check.test.ts",
            // The setup skill's teach mode offers the matching tour after each
            // configured element. Pure file reads.
            "scripts/setup-liaison-skill.test.ts",
            // A new migration that would break the previous release during a
            // rolling deploy is refused. Pure file reads.
            "scripts/check-migration-safety.test.ts",
            // A changed bundled app raises its version (a version dir is never rewritten).
            "scripts/check-bundled-app-version.test.ts",
            // Which CI jobs a pull request's paths need. Pure functions.
            "scripts/ci-scope.test.ts",
            // The raw test INSERT ratchet's counter and comparison. Pure file reads.
            "scripts/check-raw-insert.test.ts",
          ]),
    ],
    cwd: ROOT,
  },
  // Repo-root script tests: the lints, the runner and its helpers, the seeds.
  // Pure file reads and small spawns, no database.
  root: {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            // The no-dash copy lint's own unit tests, with the other repo-root lints,
            // and the sweep over the real repo that makes the rule a GATE rather than
            // a script nobody runs.
            "scripts/lint-copy-dashes.test.ts",
            // SECURITY.md stays true to what the repository ships.
            "scripts/security-policy.test.ts",
            // The full-width-Button lint's own unit tests: a fullWidth (or w-full)
            // Button is flagged only when its nearest row parent would squeeze a
            // sibling, keeping the opt-in where it belongs.
            "scripts/lint-button-width.test.ts",
            // The suite-coverage lint itself ran in no suite, so the guard against
            // decoration was decoration. Its dispatcher half lives here; the suite
            // routing half is a `guards` gate.
            "scripts/test-run.test.ts",
            // The memory budget and the run lock: pure, fast, and in no other suite.
            "scripts/lib/mem-budget.test.ts",
            // The runtime guard spawns a real small process tree and kills it, so it
            // belongs with the other repo-root lints rather than in a suite that
            // holds database state.
            "scripts/lib/mem-guard.test.ts",
            // Why the runner died, and why a failing suite never stops the run.
            "scripts/lib/run-death.test.ts",
            // The machine-wide slots: FIFO, the load gate, start-time stamps, leases.
            "scripts/lib/machine-slots.test.ts",
            "scripts/lib/test-lock.test.ts",
            // The template key that decides when a run reuses the migrated template.
            "scripts/lib/test-template.test.ts",
            // Which failed unit files the sharded runner retries (never one whose
            // failure already reproduced alone) and its wall-clock split.
            "scripts/lib/unit-retry.test.ts",
            // The silence watchdog that kills and names a wedged unit process.
            "scripts/lib/unit-watchdog.test.ts",
            // The junit report the sharded runner reads: per file, which tests failed and why.
            "scripts/lib/unit-junit.test.ts",
            // Where the sharded runner keeps its per-file timings (shared by every
            // worktree) and how a run merges into them.
            "scripts/lib/unit-timings.test.ts",
            // test:gate's planner: changed paths to suites and files, fail-safe broad.
            "scripts/test-gate.test.ts",
            // The docs guard's own tests (#207), listed by no suite until now.
            "scripts/check-docs.test.ts",
            // Shipped manifest regexes: the proven list is exactly them, each proves
            // linear, none costs a small server more than a share of the check's ceiling.
            "scripts/manifest-regex-proven.test.ts",
            // The private Redis namespace a wrapped run gets, so two processes on one
            // Redis database stop consuming each other's jobs.
            "scripts/lib/redis-prefix.test.ts",
            // The pretest reset flushes the test env's own Redis database, never db 0.
            "scripts/lib/test-redis-flush.test.ts",
            // The QA seed seals its mailbox credentials the way the API opens them.
            "scripts/seed-qa.crypto.test.ts",
            // What `db-reset` prints about the fixture stashes it found before the
            // drop. Pure string work, and in no other suite.
            "scripts/lib/fixture-stashes.test.ts",
            // Which processes must refuse to become BullMQ workers, and the guard
            // sitting first in every seed entrypoint that enforces it.
            "scripts/lib/no-job-workers.test.ts",
            "scripts/mem-cap-wiring.test.ts",
            "scripts/compose-app-origins.test.ts",
            // stop_grace_period covers the app's shutdown hard deadline and drains.
            "scripts/compose-shutdown-budget.test.ts",
            // Every variable the self-host docs name reaches the app container.
            "scripts/compose-env-passthrough.test.ts",
            // deploy/rolling-deploy.sh against a docker shim: migrate, start new
            // beside old, wait ready, only then drain old; never a bare `up`.
            "deploy/rolling-deploy.test.ts",
            "deploy/quickstart.test.ts",
            "scripts/lib/deploy-counters.test.ts",
            // deploy/backup.sh carries every key stored data needs, in step with the code.
            "scripts/backup-secrets.test.ts",
            // backup.sh --keep rotates only its own timestamped archives.
            "scripts/backup-rotation.test.ts",
            // The wrapper's own contract: the bun timeout it forwards is published to the
            // run, so a helper that bounds its own wait lands below bun's cap.
            "scripts/with-test-lock.test.ts",
            // The merge gate (pr:land): which PR checks and which main CI runs
            // count as red, and which Fixes-CI lines unlock a red main. Pure.
            "scripts/pr-land.test.ts",
            // The secret and address gates in scripts/git-hooks and the vector allowlist.
            "scripts/git-hooks.test.ts",
            // scripts/test-run.suites.test.ts is NOT listed here: it is a repo-root
            // guard and lives in the `guards` suite, which a gate actually runs.
            // The bundled-app drift guard: a bundled-app test file that exists on
            // disk but appears in no suite must fail this lint too, or the same
            // silent-decoration class of bug recurs one directory over.
            "scripts/test-run.bundled.test.ts",
            // The host <-> plugin Solid runtime contract. The shims under
            // apps/web/public/_app-runtime/ carry a LITERAL export list, so one
            // symbol missing from it takes down every bundled app UI in the browser
            // while every test stays green. This compares the shims against the real
            // solid-js namespaces and the built ui.js bundles against the shims.
            "scripts/app-runtime-shims.test.ts",
            // The compose-file image guard and the load-test scenario enumeration:
            // both are repo-root lints that ran in no suite at all.
            "scripts/compose-images.test.ts",
            "scripts/load-test.test.ts",
            // A fresh clone runs only the root install, so every package the bundled
            // app UI modules that apps/web tests import name has to be declared
            // there. It is what a fresh clone typechecks against.
            "scripts/root-typecheck-deps.test.ts",
            // infra:up resets a database shared with a second checkout of this repo,
            // so whether that reset is a decision or a side effect is a guard.
            "scripts/infra-up.test.ts",
            // The test-only Factur-X validator (XSD through xmllint, schematrons through SaxonJS):
            // it must pass the official example and catch targeted breakages, or every
            // conformance test built on it proves nothing.
            "tools/schematron/validate.test.ts",
            // docs/api-connector.md's generated format and roles tables against the
            // core JSON Schema and role registry, and the authoring skill's citations.
            "scripts/api-connector-schema-doc.test.ts",
            // First-party app signing: the source digest, the signing tool and the
            // catalog's choice between a signed artifact and a local build.
            "scripts/app-signing/sign-artifact.test.ts",
            "scripts/build-app-catalog.test.ts",
            // The release list's security marker (#639): Security: trailers on tags.
            "scripts/release-security-marker.test.ts",
          ]),
    ],
    cwd: ROOT,
  },
  // The seed engine (apps/api/src/seed): the demo tier's pure guards, then its
  // seeders against a real database. Its own suite, last in FULL_ORDER, because
  // each integration file seeds whole demo worlds.
  "demo-seed": {
    cmd: [
      "bun",
      "test",
      "--timeout",
      "180000",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            // The demo world guard (a banned-literal sweep over the world the
            // PUBLIC demo publishes), the rule that a seeded person carries no
            // uploaded picture, that a demo org never advertises an app whose
            // install failed, and that a seeded ticket approval carries the
            // ticket it acts on. Pure and fast.
            "src/seed/world/fiction.test.ts",
            "src/seed/tiers/demo/seed-profile.test.ts",
            "src/seed/tiers/demo/seed-apps.test.ts",
            "src/seed/tiers/demo/seed-support.test.ts",
            // The seed engine's own rule: one `now`, no randomness.
            "src/seed/seed-determinism.test.ts",
            // The demo-instance org seeder: it seeds its own orgs and
            // truncates nothing.
            "src/seed/tiers/demo/seed-org.integration.test.ts",
            // The seeder refuses to make an existing non-demo org a demo org.
            "src/seed/tiers/demo/seed-org-adoption.integration.test.ts",
            // The demo instance's commerce and finance batch, checked through
            // each app's own read path. It seeds its own
            // org on top of what the org seeder above leaves behind.
            "src/seed/tiers/demo/seed-commerce.integration.test.ts",
            // The demo instance's AGENT NATIVE layer (skills, routines, sub
            // agent roles, agent memory), asserted through the product's own
            // discovery paths rather than off the tables. And
            // it seeds its own org like the two above.
            "src/seed/tiers/demo/seed-agent-native.integration.test.ts",
            // The demo instance's support and collaboration batch (tickets,
            // mail through the encryption invariant, knowledge, projects,
            // calendar, contacts, approvals, threads).
            "src/seed/tiers/demo/seed-support.integration.test.ts",
            // The company knowledge scenario's world: the synced sources and
            // their access, and Support Desk's turn for Lucas running as him.
            "src/seed/tiers/demo/seed-knowledge-sources.integration.test.ts",
            // The COMPOSED world: the assertion that ONE org holds people and
            // tickets and invoices and knowledge and shipments and findings and
            // the demo marker and the Shopify connection. Its absence is what
            // let every layer pass in its own org while no org held the whole
            // world, which a database read back caught and no test did.
            "src/seed/tiers/demo/seed-demo.integration.test.ts",
            // A visitor's tailored world (their picks turn the other apps Off)
            // and the Everything world, which opens calm.
            "src/seed/tiers/demo/seed-tailored.integration.test.ts",
            // The `demo:seed` CLI's own wiring: a reserved run re-pins the App
            // Review password and keeps a second admin.
            "src/seed/tiers/demo/seed-demo-cli.integration.test.ts",
            // The accounts layer's read state: the reserved org's owner opens
            // onto a few unread conversations, not all of them.
            "src/seed/tiers/demo/seed-accounts.integration.test.ts",
            // Approve EVERY seeded approval through the real decide path: each
            // must run or fail definitely, never park as ambiguous.
            "src/seed/tiers/demo/demo-approvals.integration.test.ts",
            // The sales scenario's routine stages its reply under its own
            // scopes, addressed to the prospect, and approval delivers it.
            "src/seed/tiers/demo/sales-routine-reply.integration.test.ts",
            // The ORACLE layer: the demo analytics warehouse behind the
            // `database` connector, asserted through executeTool -> sandbox ->
            // bridge -> a real Postgres transport, plus the walls that keep a
            // demo org's SQL inside its own schema.
            "src/seed/tiers/demo/seed-warehouse.integration.test.ts",
            // What one visitor seed costs the live api and worker processes
            // (wall clock, CPU, queued work): the warm pool runs it there.
            "src/seed/tiers/demo/visitor-seed-cost.integration.test.ts",
            // The demo tier's output for a fixed base time, pinned table by
            // table (rows and content): a refactor of the engine keeps it.
            "src/seed/tiers/demo/seed-snapshot.integration.test.ts",
            // The nightly reset and the reaper: that a reset can only ever
            // empty a marked demo org, that an expired visitor org is collected
            // and a reserved one never is, and that a table the rules do not
            // cover refuses the reset instead of leaking.
            "src/seed/tiers/demo/demo-reset.integration.test.ts",
            // The lively tier: the plan's own rules, then ten people and
            // fourteen days of activity per domain (recency, no future rows),
            // a re-run that writes nothing, and a replace.
            "src/seed/tiers/lively/activity-plan.test.ts",
            "src/seed/tiers/lively/seed-lively.integration.test.ts",
            // ...and into an org someone else made, with the caller's people seated.
            "src/seed/tiers/lively/seed-lively-existing-org.integration.test.ts",
            // The load tier: synthetic orgs with their expiry, the bulk volume and
            // its invariant, and the demo reaper collecting them.
            "src/seed/tiers/load/seed-load.integration.test.ts",
          ]),
    ],
    cwd: path.join(ROOT, "apps/api"),
  },
  security: {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/tests/security",
            // The database app's read-only role: its grants against the live
            // database (allow-listed columns only, every write refused).
            path.join(ROOT, "scripts/db-readonly-role.test.ts"),
          ]),
    ],
    cwd: path.join(ROOT, "apps/api"),
  },
  // Bundled-app oracles that no other suite discovers. The workspace globs
  // cover only apps/* and packages/*, and every apps/api|web suite roots away
  // from bundled-apps/, so these ship-artifact oracles ran in NO CI suite.
  // Scoped to the vetted oracle files (manifest + UI + client-shape closure,
  // plus lab/* and metrics/*) — NOT the whole ads src tree, which also holds
  // a live-Meta suite (ads-meta-live) needing a real Meta credential this
  // suite deliberately does not provision. lab/* and metrics/* were formerly
  // excluded here as "DB-substrate integration tests", but they are actually
  // mock-driven (createMockDb / stubbed fetch, no Postgres, no Redis) and
  // pass with no database env set, so they are routed here instead of
  // exempted. cwd is the app dir so bun resolves its local tsconfig; the
  // listed files import nothing from apps/api|web.
  "bundled-ads": {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/ui-tool-closure.test.ts",
            "src/reads.test.ts",
            "src/meta-client.test.ts",
            "src/meta-upstream-errors.test.ts",
            "src/not-connected-envelope.test.ts",
            "src/connection.test.ts",
            "src/gated-preflight.test.ts",
            "src/ui/ui-logic.test.tsx",
            "src/google-pause.test.ts",
            "src/google-reads.test.ts",
            "src/google-writes.test.ts",
            "src/handlers.test.ts",
            "src/lib/google-client.test.ts",
            "src/lib/google-config.test.ts",
            "src/lib/google-error.test.ts",
            "src/lib/merchant-client.test.ts",
            "src/lib/sha256.test.ts",
            "src/manifest.test.ts",
            "src/merchant-reads.test.ts",
            "src/pause-summarizers.test.ts",
            "src/pause.test.ts",
            "src/routines/gen-manifest-routines.test.ts",
            "src/routines/routines-sync.test.ts",
            "src/skills/skills-frontmatter.test.ts",
            "src/skills/skills-sync.test.ts",
            "src/ui/limited-invoke.test.tsx",
            "src/writes.test.ts",
            // Routed from KNOWN_UNROUTED_BUNDLED: excluded as "DB-substrate"
            // but mock-driven (createMockDb / stubbed fetch), pass with no
            // Postgres/Redis. schema.integration.test.ts is named
            // "integration" but asserts schema SHAPE against the in-memory
            // ctx.db mock, not a live database.
            "src/lab/audience-erasure-consumer.test.ts",
            "src/lab/consent-join.test.ts",
            "src/lab/dealer-profiles.test.ts",
            "src/lab/experiment-ride.test.ts",
            "src/lab/experiments.test.ts",
            "src/lab/manual-spend.test.ts",
            "src/lab/schema.integration.test.ts",
            "src/lab/summarizers.test.ts",
            "src/metrics/inputs.test.ts",
            "src/metrics/registry.test.ts",
            "src/metrics/tools.test.ts",
          ]),
    ],
    cwd: path.join(ROOT, "bundled-apps/ads"),
  },
  // Shopify bundled-app oracles that no other suite discovers -- same orphan as
  // bundled-ads: the workspace globs cover only apps/* + packages/*, and the
  // apps/api integration suite's `shopify-order-event-contract.test.ts` lives under
  // apps/api, NOT here, so these ship-artifact UI/pure-logic oracles ran in NO
  // CI suite. Scoped DELIBERATELY to the vetted, dependency-free `.ts` oracle
  // files (list/home/settings humanizers + the detail url-template renderer) --
  // NOT the whole shopify src tree, which also holds DB-touching integration
  // tests (schema, handlers/*, reads) and connection/webhook suites that need a
  // Postgres substrate + shop credentials this suite deliberately does not
  // provision. cwd is the app dir so bun resolves its local tsconfig; the listed
  // files import nothing from apps/api|web.
  "bundled-shopify": {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/ui/lists.test.ts",
            "src/ui/home.test.ts",
            "src/ui/settings.test.ts",
            "src/ui/panels/url-template.test.ts",
            // Pure query-shape oracle: Home's unfulfilled-past-SLA query must keep
            // status:open (refunded/archived orders stay UNFULFILLED forever).
            "src/handlers/home.query.test.ts",
            // Pure weak-model-input normalisation + the draft-order buyer-identity guard.
            // Mock-driven (makeCtx), no Postgres/shop creds, so it belongs in this vetted list.
            "src/mutations.test.ts",
            // Pinned export set of the mutations index over src/mutations/ (pure, no I/O).
            "src/mutations.export-set.test.ts",
            // Partial-fulfillment planning read (fulfillment_orders_get) — mock-driven fetch stub,
            // no Postgres/shop creds, same class as mutations.test.ts.
            "src/fulfillment-orders.test.ts",
            // Manifest oracles, including the attention-RESOLUTION contract: an
            // attention row is a frozen snapshot, so every transient kind needs a
            // resolving translation or the feed keeps asserting state the store
            // left long ago ("New order #3330" for an order shipped last week).
            "src/manifest.test.ts",
            // Pure NormalizedDraftOrder normalizers (quotes-are-draft-orders design):
            // REST webhook payload + GraphQL node -> the shared shape invoicing consumes.
            // No I/O, no ctx — same vetted class as the other mock-driven files here.
            "src/lib/draft-order.test.ts",
            // Webhook handlers: dedup ledger, shop-domain validation, Cluster-1 emit
            // identity, and the draft_orders/{create,update,delete} contract. Mock-driven
            // (makeCtx), no Postgres/shop creds — was never wired into CI before.
            "src/webhooks.test.ts",
            // OAuth connection lifecycle + subscribeShopifyTopics (idempotent webhook
            // topic registration) + webhooks_repair (re-register topics on an
            // already-connected shop). Mock-driven fetch/connections stub, no
            // Postgres/shop creds — was never wired into CI before.
            "src/connection.test.ts",
            // install_metadata resolution: the read path derives a missing row in memory
            // and never inserts (scope taint refuses a read that writes); the hourly scan
            // job persists the heal. Mock-driven ctx, no Postgres/shop creds.
            "src/lib/get-client.test.ts",
            "src/handlers/scan-unfulfilled.test.ts",
            // Webhook upstream probe: what the kernel's silence signal trusts. Mock ctx.
            "src/handlers/probe-webhook-upstream.test.ts",
            // settings_load's SettingsBundle shaping (connection status, identity
            // mappings, diagnostics, allowlist). Mock-driven table-backed ctx, no
            // Postgres/shop creds -- same vetted class as connection.test.ts; was
            // never wired into CI before (X3d).
            "src/handlers/settings.test.ts",
            "src/abandoned-checkouts.test.ts",
            "src/analytics-query.test.ts",
            "src/handlers.test.ts",
            "src/handlers/backfill-customers.test.ts",
            // The invoicing document subscriber relaying order:invoice_changed. Mock ctx.
            "src/handlers/invoice-relay.test.ts",
            "src/handlers/prune-webhook-deliveries.test.ts",
            "src/handlers/reconcile-customers.test.ts",
            "src/handlers/scope-seed.test.ts",
            "src/handlers/staff-overrides.test.ts",
            "src/inventory-value.test.ts",
            "src/lib/hmac.test.ts",
            "src/lib/install-metadata.test.ts",
            "src/lib/kernel-contacts.test.ts",
            "src/lib/shopify-client.test.ts",
            "src/reads.test.ts",
            "src/repeat-rate.test.ts",
            "src/schema.test.ts",
            "src/search.test.ts",
            "src/summarizers.test.ts",
            // The dev-store seed's catalog loader (fiction default, env-named module).
            "scripts/dev-store-catalog.test.ts",
          ]),
    ],
    cwd: path.join(ROOT, "bundled-apps/shopify"),
  },
  // Invoicing bundled-app oracles -- same orphan class as bundled-ads/shopify:
  // nothing else discovers bundled-apps/invoicing tests. Scoped to the vetted
  // mock-driven files (no Postgres/credentials): mutations (issuer defaulting,
  // issued-invoice immutability, draft-order-id rejection, money/discount
  // handling) + manifest (agent-instruction completeness, summarizers, version).
  "bundled-invoicing": {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/mutations.test.ts",
            // The invoicing.document import kind (bundle export, create-only).
            "src/import-kind.test.ts",
            // Pinned export set of the mutations index over src/mutations/ (pure, no I/O).
            "src/mutations.export-set.test.ts",
            "src/manifest.test.ts",
            // Every gated tool's approval card reads as words (summarizers + handler cards, pure).
            "src/approval-cards.test.ts",
            "src/deferred.test.ts",
            "src/money.test.ts",
            // CSV formula cells, currency exponents, gated settings tools (pure).
            "src/csv-money-and-gated-settings.test.ts",
            "src/numbering.test.ts",
            // The one door of the issue date and number year, with its guard over the issue paths.
            "src/issue-date.test.ts",
            "src/state.test.ts",
            "src/tax.test.ts",
            // E-invoicing pure core (territory, identity, regime classifier, operation type).
            "src/einvoicing/territory.test.ts",
            // E-invoicing transmission and booking through the bound PA provider (the Pennylane
            // adapter over its recorded-shape fake behind a contract-call stub).
            "src/einvoicing/transmit.test.ts",
            // Received supplier e-invoices: the safe XML reader (DTD/entity/size/time refusals),
            // the mirror and its refuse/dispute approvals over the same adapter and fake.
            "src/received/xml.test.ts",
            "src/received/received.test.ts",
            "src/einvoicing/settings-tool.test.ts",
            "src/einvoicing/settings-page.test.ts",
            "src/einvoicing/identity.test.ts",
            "src/einvoicing/classify.test.ts",
            "src/einvoicing/classify-operation.test.ts",
            "src/einvoicing/gate.test.ts",
            "src/einvoicing/identity-derive.test.ts",
            // Auto credit notes parked on the buyer's identity, re-issued alone by the retry sweep.
            "src/einvoicing/parked-credit-note.test.ts",
            // Recorded registry / ECB responses stay anonymised (fictional names and SIRENs only).
            "src/einvoicing/fixtures.test.ts",
            "src/einvoicing/lookup.test.ts",
            // ECB reference rate: parse, cache, EUR conversion, warm-up job.
            "src/einvoicing/fx.test.ts",
            "src/einvoicing/identity-tools.test.ts",
            // Identity backfill + identity-confirm job; readiness (blocker codes = the gate's codes).
            "src/einvoicing/backfill.test.ts",
            "src/einvoicing/readiness.test.ts",
            // Imported legacy originals: pure-JS SHA-256 + the gated backfill that records/restores them.
            "src/einvoicing/backfill-sha256.test.ts",
            "src/einvoicing/backfill-legacy.test.ts",
            "src/einvoicing/never-stuck.test.ts",
            // Factur-X: CII builder units and the conformance suite (XSD + schematrons, mutation suite).
            "src/facturx/cii.test.ts",
            "src/facturx/conformance.test.ts",
            // Legal original fixed at issue (Factur-X for e_invoice), retry, management copies.
            "src/legal-originals/record.test.ts",
            "src/legal-originals/verify.test.ts",
            "src/einvoicing/classify-tool.test.ts",
            "src/reads.for-orders.test.ts",
            "src/handlers/shopify-product-changed.test.ts",
            "src/handlers/shopify-order-cancelled.test.ts",
            "src/handlers/shopify-refund-credit-note.test.ts",
            // Permanent property guard for buildAdjustmentReversalItems (promoted from the
            // adversarial review's throwaway fuzz harness): both exactness invariants plus the
            // pinned minimal repro of the overshoot defect, over a fixed deterministic grid.
            "src/handlers/shopify-refund-adjustment-reversal.property.test.ts",
            "src/handlers/e4-handlers.test.ts",
            // Guard for the shared findBillingDocumentsForOrder helper (billing-documents.ts):
            // a credit note inherits its original invoice's shopify_order_id, so every
            // "billing documents for this order" consumer must exclude it centrally.
            "src/handlers/billing-documents.test.ts",
            "src/ui/Editor.test.tsx",
            // The editor links a contact by name (search + pick), never by raw id.
            "src/ui/ContactPicker.test.tsx",
            "src/ui/ContactDocumentsPanel.test.tsx",
            "src/ui/DocumentDetail.test.tsx",
            // The Deferred tab: open parks, tax reviews first, gated override outcome.
            "src/ui/DeferredList.test.tsx",
            // E-invoicing surfaces: the calm regime line, the customer identity tab (lookup never
            // picks a candidate) and the readiness tab (one action per blocker).
            "src/ui/einvoicing/RegimeLine.test.tsx",
            "src/ui/einvoicing/TransmissionPanel.test.tsx",
            // The Received tab's view model (charter: words with codes, no action on a terminal
            // or paid invoice, the XML original never previewed).
            "src/ui/received/view.test.ts",
            "src/ui/einvoicing/EinvoicingRegistration.test.tsx",
            "src/ui/identity/IdentityEditor.test.tsx",
            "src/ui/readiness/Readiness.test.tsx",
            // FOOTER_ACTIONS.idParam vs. the manifest: pins the id key each footer
            // action sends against its own tool's declared params (mark-paid /
            // send-to-customer / convert-to-invoice each require a different key;
            // a mismatch made those buttons silently no-op in prod).
            "src/ui/footer-action-params.test.ts",
            "src/ui/DocumentsList.test.ts",
            // The documents search carried in the route (`?q=`), across the two frames.
            "src/ui/search-store.test.ts",
            "src/ui/index.test.ts",
            "src/ui/settings.test.tsx",
            "src/ui/sidebar.test.tsx",
            // The UI copy follows the reader's language (tr + i18n-fr.ts).
            "src/ui/i18n.test.ts",
            "src/ui/dashboards/DataTable.test.ts",
            "src/ui/dashboards/dashboards.test.ts",
            // Writes are offered only to a viewer holding them (viewer_access), and a refused issuer read is not "no issuer".
            "src/ui/access.test.ts",
            "src/ui/issuer-load.test.ts",
            "scripts/check-numbering.test.ts",
            "scripts/validate-customs-pdf.test.ts",
            // The issuance seam itself (D7): tax + numbering + money + PDF + thread post
            // composed against createMockDb. It was written mock-driven like its siblings but
            // never listed here, so nothing in CI ran it -- wired in 2026-09-08.
            "src/issue.test.ts",
            // Recipient completeness: a document cannot be ISSUED without a name, address,
            // email and country, and a draft-based issue must carry the DRAFT's recipient
            // rather than the old hardcoded "Customer" stub (both reported from production).
            "src/counterparty-completeness.test.ts",
            // Per-shipment proforma (shipment_ref) oracles: schema uniqueness key,
            // webhook-idempotency isolation, and reads exposure. All mock-driven
            // (createMockDb), no Postgres/credentials.
            "src/schema.test.ts",
            "src/reads.test.ts",
            // Finding a customer's earlier sale: address/line/contact search, ranking, the no-hit
            // hint and customer_history.
            "src/customer-history.test.ts",
            // vat_lookup: web search + national VAT formats + VIES, ranked (stubbed, pure).
            "src/vat-lookup.test.ts",
            // The Editor's open -> save -> issue round trip through the REAL reads.ts /
            // mutations.ts / ui/index.ts / ui/Editor.ts functions: a line with no per-line VAT
            // override must survive an unchanged open-and-save (not lose its tax, not freeze the
            // issuer's current rate in as a false override), an explicit 0 percent override
            // survives the same round trip, and a genuinely changed rate takes hold.
            "src/editor-round-trip.test.ts",
            "src/handlers/shopify-order-paid.test.ts",
            // Quotes ARE Shopify draft orders: the four draft_order:* handlers, mock-driven
            // (createMockDb + stubbed executeTool). Pins the one-quote-per-draft-order
            // idempotency across BOTH event producers (the fat webhook payload and the thin
            // tool one that carries only a gid), the discount/carriage mapping, the
            // wait-for-the-address path, completed -> invoiced and deleted -> rejected.
            "src/handlers/shopify-draft-order.test.ts",
            // The overdue scan, INCLUDING its resolution half: a past-due invoice
            // that has since been paid must re-emit with days_overdue 0 so its
            // stale "N days overdue" attention row clears instead of lingering.
            "src/handlers/overdue-scan.test.ts",
            // Scheduled Shopify payment reconciliation (createMockDb + stubbed executeTool, no
            // Postgres/creds): the late-settlement flip AND the bounded inline settled-PDF re-render.
            "src/handlers/reconcile-shopify-payments.test.ts",
            // One-time order-number backfill (createMockDb + stubbed executeTool): fills the
            // human Shopify order number on documents issued before the column existed, so the
            // whole history is searchable by order number. Pins its idempotency/self-termination.
            "src/handlers/backfill-order-numbers.test.ts",
            // Shipment write back (createMockDb + stubbed boxtal:search): an invoice records the
            // Boxtal shipment created against it in external_refs.shipments, never shipment_ref.
            "src/handlers/link-shipments.test.ts",
            // Split-order pairing (pure, no host/db): keeps the goods+software
            // halves of one order adjacent and linked in OUR list, and the
            // download-both action that saves them as two separate files --
            // never merged, or the software lines end up in front of the
            // customs officer reading the goods invoice.
            "src/ui/dashboards/pair-split.test.ts",
            "src/ui/dashboards/pair-download.test.ts",
            // Non-Latin text (two user reports; "Igor Lukawski" printed as
            // "Igor ?ukawski" on a real issued invoice). Pins what survives to
            // the embedded font and what the last-resort fallback does with the
            // little that font lacks. Pure, no host import.
            "templates/unicode-text.test.ts",
            // PDF template command-shape oracles (pure — renders DrawCommand[], no host import,
            // no Postgres/creds). Guards the totals/payment-box invariants: unpaid -> "Total due" +
            // banking box, paid -> "Amount paid" + "Paid on <date>" + no banking box, and the JPY
            // zero-decimal money path.
            "templates/templates.test.ts",
          ]),
    ],
    cwd: path.join(ROOT, "bundled-apps/invoicing"),
  },
  // Boxtal bundled-app oracles -- same orphan class. Mock-driven files only
  // (createMockDb + stubbed fetch): the quote/draft/create flows, the v1
  // cotation parser (collection/delivery types), and the manifest oracle.
  "bundled-boxtal": {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/shipment.test.ts",
            // Country names without Intl (the QuickJS sandbox has none), and the invoice-address
            // parser run with Intl removed.
            "src/country-names.test.ts",
            "src/invoice-address-no-intl.test.ts",
            // Which address a draft ships to: one source, the order's ship-to first, verified
            // addresses from the contact address book, and the golden "no verified address,
            // no change" proof over ~50 real-shaped orders.
            "src/address-check.test.ts",
            "src/shipment-address.test.ts",
            "src/address-golden.test.ts",
            // The order and the verified address differ: held until a person picks, the pick
            // voided by an address change, the card line only once a verified address exists.
            "src/address-differs.test.ts",
            // Import kinds: local products, packs and shipping profiles, create-only.
            "src/import-kind.test.ts",
            // Pure export-resolution flavor of this filename -- asserts every
            // manifest-referenced handler/UI export actually exists. NOT the
            // shell-spawning flavor of the same filename in ads/shopify/invoicing
            // (that one lives in the "bundled-freeze" suite instead).
            "src/build-roundtrip.test.ts",
            "src/lib/boxtal-v1-client.test.ts",
            "src/manifest.test.ts",
            "src/settings.test.ts",
            // The carton ladder, stacking thresholds and nominal proforma value are org data
            // (packaging_policy). Pins identical output for the policy the code used to hardcode,
            // over a swept golden, and the neutral default (one raw stack, no carton) without it.
            "src/resolver-characterization.test.ts",
            "src/carriers.test.ts",
            "src/prep.test.ts",
            "src/prep-e2e.test.ts",
            // prep-meta: warming the per-document prep-meta cache (warmPrepMetaForDocument)
            // that the prep worklist reads instead of recomputing on every row.
            "src/prep-meta.test.ts",
            "src/customs.test.ts",
            // Declared-value currency conversion at the carrier boundary: Boxtal
            // reads every figure as EUR, so a non-EUR invoice must be converted
            // (or blocked), never relabelled (ticket-10154).
            "src/fx.test.ts",
            // The other half of that conversion: the Shopify order reference must
            // reach orders_get in GID form. Invoicing persists the bare numeric
            // id, orders_get resolves only the gid, and the mismatch silently
            // blocked every non-EUR export's customs value (2026-08-03).
            "src/shopify-ref.test.ts",
            "src/webhooks.test.ts",
            "src/label-tracking.test.ts",
            // A bought label with no document after 15 minutes: one attention item, cleared on arrival.
            "src/label-missing.test.ts",
            "src/fulfillment.test.ts",
            "src/ui/worklist-logic.test.ts",
            // The scheduled convergence net under the webhook stream. Webhooks are
            // a silent single point of failure (a secret drift rejects every
            // delivery at the verifier, before any ledger row); this job re-reads
            // Boxtal on a cron so a lost event costs one interval, not forever.
            "src/reconcile-tracking.test.ts",
            // Partial-shipment batches: subset drafts, batch reservation semantics,
            // worklist remaining-units, preflight overship, the two-batch journey
            // (proforma per batch + per-line fulfillment).
            "src/partial.test.ts",
            // Queue worklists (ready/returns/to-prepare/exceptions) — includes the
            // print-station regression (PENDING labels must appear in ready_list).
            "src/queues.test.ts",
            // Linked documents are named by their number, never their id.
            "src/document-numbers.test.ts",
            // queue-facts / queue-facts-backfill: the cached per-parcel facts (weight,
            // dims, category) a queue row reads instead of re-deriving, and the
            // one-time backfill's own idempotency (which rows still need it, which
            // already carry a wrong return category).
            "src/queue-facts.test.ts",
            "src/queue-facts-backfill.test.ts",
            // Address rules (state + destination-aware NANP phone), the package
            // resolver (accessory auto-parceling), and the two-job print pack.
            "src/address.test.ts",
            "src/resolver.test.ts",
            // The house packing rules as the operations team specified them: the reference
            // engine's 27 tests plus a differential replay of the real worklist and a sweep.
            "src/resolver-reference-engine.test.ts",
            "src/print-pack.test.ts",
            // print-pack-batch: the multi-shipment batch flavor of the same print job
            // (one PDF merge across N labels) plus its own summary line.
            "src/print-pack-batch.test.ts",
            // print-record: the shipment's print record for the document templates (buy-time
            // snapshot, live tracking number, nothing the sources do not hold).
            "src/print-record.test.ts",
            // attention / attention-store: the boxtal attention-feed rule evaluator
            // (condition/rule matching over parcel facts) and the persisted rule
            // CRUD (upsert/list/load) it reads from.
            "src/attention.test.ts",
            "src/attention-store.test.ts",
            // staff-note: the prep row's staff-note mutation (prepSetNote), including
            // the cross-app envelope it accepts.
            "src/staff-note.test.ts",
            "src/ui/PrepGrid.test.ts",
            // One decision per label purchase, on its row: a parked purchase is never read as a
            // bought label, and the grid decides through the boxtal-scoped approvals feed.
            "src/ui/ship-approval.test.ts",
            // prep-cache: the persisted (localStorage) worklist cache -- load/save/evict/key
            // building and the org id decode, all storage-injected so they run with no DOM.
            "src/ui/prep-cache.test.ts",
            // prep-view-state: the cache-first-paint-then-unconditional-refresh open plan, the
            // refresh banner/empty-state decision, and the row exit transition reconcile behind
            // the stale-while-revalidate "To prepare" grid rework (2026-09-10).
            "src/ui/prep-view-state.test.ts",
            "src/ui/ui-logic.test.tsx",
            "src/ui-tool-closure.test.ts",
            // The order-driven worklist rework (2026-09-04). The row is now the ORDER, not the
            // issued invoice, and every row action patches ONE row instead of re-listing the grid.
            // order-state: status/exclusion/category keyed by order_key, with the legacy per-document
            // flags seeded on first write so nothing an operator already ticked is lost.
            "src/order-state.test.ts",
            // orders: the scan's own contract -- which Shopify fulfillment states are shipping work
            // (the query provably excluded on-hold/partial orders), the fail-soft rule (a Shopify
            // read failure returns the CACHED rows, never an empty queue), the row-scoped read's
            // parity with the list read, the pending-proforma re-key, exponent-aware money and the
            // untrusted order number that reaches a Shopify search query.
            "src/orders.test.ts",
            // proforma: the nominal 1 EUR document a repair or sample ships on, ONE LINE PER
            // PHYSICAL ITEM (a single summary line resolves to one parcel and declares nothing that
            // is actually in the box), plus the correlation ref that matches an approved proforma
            // back to its row.
            "src/proforma.test.ts",
            // prep-row-logic: every button state as a decidable function of the row, and
            // `mutationPlan` -- the enforceable form of "a row action never re-lists the grid".
            "src/ui/prep-row-logic.test.ts",
            // carrier-mark: the brand -> glyph resolution behind the COLLAPSED carrier control in
            // the total cell (the offer picker is the carrier's logo now). Pins that every carrier
            // this org ships with resolves to a mark, that every mark carries an accessible name,
            // and that an unknown carrier falls back to a text name rather than a nameless glyph.
            "src/ui/carrier-mark.test.ts",
            // product-codes: the PRODUCTS column's resolution. A B2B sku carries no shipping
            // profile, so an un-invoiced order printed nine wrapped lines of raw
            // `EMB-...-B2B` skus (with one product listed twice) where the retail rows next to
            // it read `1xET2`. Pins the wrapper strip, the retail-code aliases, the duplicate
            // MERGE, and that an unknown sku degrades readably instead of vanishing.
            "src/product-codes.test.ts",
            // Profile short codes copied onto the kernel's product attributes, read back first.
            "src/product-attributes.test.ts",
            // STANDING ORACLE: a refunded or cancelled Shopify order must never
            // become shippable. Prod 2026-08-05, order #3320 sat in the
            // to-prepare worklist fully refunded, hidden only by an unrelated
            // customs-FX failure -- fixing that FX bug alone would have promoted
            // it to "ready to prepare".
            "src/order-shippability.test.ts",
            "src/catalog.test.ts",
            // Shared shipping profiles: the zero-difference proof (migration + merge keep every
            // resolution) and the link / unlink / merge / delete tools with their refusals.
            "src/profiles.test.ts",
            // The one parcel-line rule the worklist and staging share.
            "src/shippable-lines.test.ts",
            "src/ui/i18n.test.ts",
            "src/claims.test.ts",
            "src/connection.test.ts",
            "src/draft-store.test.ts",
            "src/import.test.ts",
            "src/lib/boxtal-v3-client.test.ts",
            "src/lib/get-client.test.ts",
            "src/lib/hmac.test.ts",
            "src/link-store.test.ts",
            "src/quote-batch.test.ts",
            "src/probe-webhook-upstream.test.ts",
            "src/reads.test.ts",
            "src/schema.test.ts",
            "src/search.test.ts",
            "src/smoke.test.ts",
            "src/summarize-error.test.ts",
            "src/summarizers.test.ts",
            "src/ui/BoxtalShipmentTab.test.tsx",
            // file-open: a fetched label or invoice goes to the host's native opener on
            // desktop (the webview opens no blob tab) and to the pre-opened tab in a browser.
            "src/ui/file-open.test.ts",
            "src/unlinked.test.ts",
            // sidebar: pins the badge fetch coalescing (route gate, 250ms debounce,
            // single flight with one trailing refresh). The regression test for the
            // page-open burst that deadlocked the sandbox worker pool in prod.
            "src/ui/sidebar.test.tsx",
            // prep-cache-mode: pins the cached scan mode, including the shipped
            // parcel safety rule (a row fully covered by a live local shipment is
            // dropped) and that prep_sync stays on the live scan.
            "src/prep-cache-mode.test.ts",
          ]),
    ],
    cwd: path.join(ROOT, "bundled-apps/boxtal"),
  },
  // Monitoring bundled-app oracles -- same orphan class. Fully mock-driven
  // (test-ctx in-memory AppContext + the pure-node hmac testutil bridge): the
  // alert-webhook lifecycle (create/fold/reopen/escalate), the ack/resolve
  // tools, the HMAC verifier (signature + ts-freshness + replay key), and the
  // manifest oracle. No Postgres/credentials needed.
  "bundled-monitoring": {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/webhooks.test.ts",
            "src/incidents.test.ts",
            "src/comments.test.ts",
            "src/incidents-summary.test.ts",
            "src/lib/hmac.test.ts",
            "src/lib/profiles.test.ts",
            "src/lib/refs.test.ts",
            "src/lib/summarize.test.ts",
            "src/manifest.test.ts",
            // The in-memory ctx double behaves like the sandbox bridge.
            "src/test-ctx.test.ts",
            "src/ui/format.test.ts",
            // By-source views: order, lanes, urgent callout, hue, link safety.
            "src/ui/sources.test.ts",
            // The UI copy follows the reader's language (tr + i18n-fr.ts).
            "src/ui/i18n.test.ts",
          ]),
    ],
    cwd: path.join(ROOT, "bundled-apps/monitoring"),
  },
  // Report-skills oracles (docs/skills/* + seed-report-skills.ts) — repo-root
  // files no other suite discovers. Self-contained: pure file/schema checks,
  // a fake-API idempotency test, and a python3-stdlib verify-report.py round
  // trip (fixture built in a tmpdir). No DB/Redis/credentials.
  //
  // scripts/report-skills.test.ts is not on this branch yet, so the suite is
  // declared PENDING (scripts/lib/pending-suites.ts): the runner skips it with
  // a reason and exit 0, and the day the file lands the declaration goes stale
  // and its own guard says so. Deleting the suite instead would lose that.
  "report-skills": {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter ? fileArg : ["scripts/report-skills.test.ts"]),
    ],
    cwd: ROOT,
  },
  // Pennylane bundled-app oracles -- same orphan class. Fully mock-driven
  // (fake fetch, in-memory db doubles, no Postgres/credentials). Note:
  // build-roundtrip.test.ts here is the PURE export-resolution flavor -- it
  // imports ./handlers and reads app.manifest.json, it does NOT shell out to
  // a build, unlike the ads/shopify/invoicing files of the same name.
  "bundled-pennylane": {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/build-roundtrip.test.ts",
            "src/connection.test.ts",
            "src/lib/pennylane-client.test.ts",
            "src/manifest.test.ts",
            "src/pnl.test.ts",
            "src/reads.test.ts",
            "src/summarizers.test.ts",
            "src/upload.test.ts",
            // Reception ops: download hops and credentials, catch-up cursor, allowed actions.
            "src/received/received.test.ts",
            // einvoicing-pa@1 provider: the SDK conformance kit over the recorded-shape fake, and
            // the adapter's own cases. The sandbox drift file is opt-in (skips without its env).
            "src/einvoicing/conformance.test.ts",
            "src/einvoicing/adapter.test.ts",
            "src/einvoicing/sandbox-drift.test.ts",
            "src/einvoicing/webhooks.test.ts",
            // Each provider op error answers with its own HTTP status.
            "src/einvoicing/errors.test.ts",
            // Webhook upstream probe: newest received e-invoice, null without a sender, no report when unreachable.
            "src/einvoicing/probe-webhook-upstream.test.ts",
          ]),
    ],
    cwd: path.join(ROOT, "bundled-apps/pennylane"),
  },
  // Calls bundled-app oracles -- same orphan class. The DB-backed webhook
  // counterpart under apps/api stays in the `integration` suite, which is where
  // it is listed by name; these are the mock-driven unit halves, no
  // Postgres/credentials needed. (The path is deliberately not spelled out
  // here: the routing oracle counts a name anywhere in a suite block, comments
  // included, and would read a second mention as a double routing.)
  "bundled-calls": {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/doc-format.test.ts",
            "src/envelope.test.ts",
            "src/hmac.test.ts",
            "src/manifest.test.ts",
            "src/tools.test.ts",
            "src/webhooks.test.ts",
          ]),
    ],
    cwd: path.join(ROOT, "bundled-apps/calls"),
  },
  // Social bundled-app oracles -- same orphan class. Fully mock-driven
  // (mocked adapter fetches, in-memory db doubles), no Postgres/credentials.
  "bundled-social": {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/adapters/cursor.test.ts",
            "src/adapters/facebook.test.ts",
            "src/adapters/instagram.test.ts",
            "src/adapters/newest-first.test.ts",
            "src/adapters/youtube.test.ts",
            "src/attention.test.ts",
            "src/auto-watch.test.ts",
            "src/connection.test.ts",
            "src/dm-state.test.ts",
            "src/dm-window.test.ts",
            "src/handlers.test.ts",
            "src/ingest.test.ts",
            "src/internal.test.ts",
            "src/lib/html-entities.test.ts",
            "src/manifest.test.ts",
            "src/meta-pages.test.ts",
            "src/own-auto-watch.test.ts",
            "src/pending.test.ts",
            "src/post-back.test.ts",
            "src/probe-webhook-upstream.test.ts",
            "src/quota.test.ts",
            "src/reads.test.ts",
            "src/settings-status.test.ts",
            "src/summarizers.test.ts",
            "src/sync.test.ts",
            "src/ui/ui-logic.test.tsx",
            "src/webhooks-setup.test.ts",
          ]),
    ],
    cwd: path.join(ROOT, "bundled-apps/social"),
  },
  // The ship-artifact gate: proves the freeze step still produces a loadable
  // tarball. `build-roundtrip.test.ts` in ads/shopify/invoicing is a DIFFERENT
  // test wearing the same filename as the pure flavor in boxtal/pennylane --
  // it spawnSyncs `bash scripts/build-bundled-app.sh <app> --skip-sign
  // --skip-typecheck` (a real esbuild + `bun install` + tar), then inspects
  // the produced `.liaisonapp` tarball. A broken freeze means a bundled app
  // ships broken, so this is its own suite rather than folded into the
  // per-app bundled-* suites: those promise a mock-driven "no I/O beyond
  // mocks" contract and run with cwd inside the app dir, and this test
  // deliberately breaks that contract by spawning a real build. Kept
  // separate so a network-restricted runner fails ONE clearly-named suite
  // instead of poisoning three fast oracle suites. cwd is ROOT (not the app
  // dir) because these three files import only node:child_process/node:fs,
  // so they are root-portable -- unlike the pure flavor, which imports a
  // .tsx UI barrel that needs the app's own tsconfig.
  "bundled-freeze": {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "bundled-apps/ads/src/build-roundtrip.test.ts",
            "bundled-apps/shopify/src/build-roundtrip.test.ts",
            "bundled-apps/invoicing/src/build-roundtrip.test.ts",
          ]),
    ],
    cwd: ROOT,
  },
  // The desktop shell and its Bun sidecar. apps/desktop is a workspace package
  // no other suite's cwd reaches, so unlisted here its tests would be
  // decoration. The Rust `cargo check` in scaffold.test.ts is why the timeout
  // is generous: a cold dependency tree compiles for minutes.
  desktop: {
    cmd: [
      "bun",
      "test",
      "--timeout",
      "600000",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter ? fileArg : desktopBunTests()),
    ],
    cwd: path.join(ROOT, "apps/desktop"),
  },
  // The overlay's Solid components. `bun test` has no Solid JSX transform, so
  // they run under vitest + jsdom exactly as apps/web's do; the pure modules
  // stay in the `desktop` suite above. Both halves are listed, because a half
  // no suite runs is decoration.
  "desktop-ui": {
    cmd: ["bunx", "--bun", "vitest", "run", ...bailBun, ...vitestTestFlags, ...fileArg],
    cwd: path.join(ROOT, "apps/desktop"),
  },
  // The shared app kit's Solid components (@liaison/app-ui). `bun test` has no
  // Solid JSX transform, so CardTable and anything else with JSX runs under
  // vitest + jsdom exactly as `desktop-ui` does; the package's pure modules
  // (ctx-iframe) stay in `workspace-packages`. The vitest include pattern is
  // `*.vitest.tsx` so the bun half cannot discover a file it cannot transform.
  "app-ui-ui": {
    cmd: ["bunx", "--bun", "vitest", "run", ...bailBun, ...vitestTestFlags, ...fileArg],
    cwd: path.join(ROOT, "packages/app-ui"),
  },
  // The ads app's rendered screens (`*.vitest.tsx`), on the vitest + jsdom
  // toolchain packages/app-ui installs (see bundled-apps/ads/vitest.config.ts).
  "bundled-ads-ui": {
    cmd: [
      path.join(ROOT, "packages/app-ui/node_modules/.bin/vitest"),
      "run",
      "--config",
      "vitest.config.ts",
      ...bailBun,
      ...vitestTestFlags,
      ...fileArg,
    ],
    cwd: path.join(ROOT, "bundled-apps/ads"),
  },
  // The invoicing app's rendered screens (`*.vitest.tsx`), same toolchain as
  // `bundled-ads-ui` (see bundled-apps/invoicing/vitest.config.ts).
  "bundled-invoicing-ui": {
    cmd: [
      path.join(ROOT, "packages/app-ui/node_modules/.bin/vitest"),
      "run",
      "--config",
      "vitest.config.ts",
      ...bailBun,
      ...vitestTestFlags,
      ...fileArg,
    ],
    cwd: path.join(ROOT, "bundled-apps/invoicing"),
  },
  // The social app's rendered screens (`*.vitest.tsx`), same toolchain as
  // `bundled-ads-ui` (see bundled-apps/social/vitest.config.ts).
  "bundled-social-ui": {
    cmd: [
      path.join(ROOT, "packages/app-ui/node_modules/.bin/vitest"),
      "run",
      "--config",
      "vitest.config.ts",
      ...bailBun,
      ...vitestTestFlags,
      ...fileArg,
    ],
    cwd: path.join(ROOT, "bundled-apps/social"),
  },
  // The Boxtal app's rendered screens (`*.vitest.tsx`), same toolchain as
  // `bundled-ads-ui` (see bundled-apps/boxtal/vitest.config.ts).
  "bundled-boxtal-ui": {
    cmd: [
      path.join(ROOT, "packages/app-ui/node_modules/.bin/vitest"),
      "run",
      "--config",
      "vitest.config.ts",
      ...bailBun,
      ...vitestTestFlags,
      ...fileArg,
    ],
    cwd: path.join(ROOT, "bundled-apps/boxtal"),
  },
  // The monitoring app's rendered screens (`*.vitest.tsx`), same toolchain as
  // `bundled-ads-ui` (see bundled-apps/monitoring/vitest.config.ts).
  "bundled-monitoring-ui": {
    cmd: [
      path.join(ROOT, "packages/app-ui/node_modules/.bin/vitest"),
      "run",
      "--config",
      "vitest.config.ts",
      ...bailBun,
      ...vitestTestFlags,
      ...fileArg,
    ],
    cwd: path.join(ROOT, "bundled-apps/monitoring"),
  },
  // The Capacitor shell. Discovery is bun's own rather than a hand written
  // list: apps/mobile has no JSX of its own (it wraps apps/web's build), so
  // every test here is a plain bun file and a new one must not be able to land
  // in a directory no suite reaches. The generated ios/ and android/ projects
  // hold no tests.
  mobile: {
    cmd: ["bun", "test", "--timeout", "120000", ...bailBun, ...bunTestFlags, ...fileArg],
    cwd: path.join(ROOT, "apps/mobile"),
  },
  // The apps/api STATIC guards: pure source scans and pure env/config oracles
  // that open no database. They live in src/tests, which the `unit` suite's
  // path list does not reach and the `integration` suite enumerates by hand, so
  // each of them ran in NO suite: raw-fetch-discipline and no-stripe-imports
  // were red for the whole of an epic and no gate said a word. They are file
  // reads plus one grep, so the suite costs a second and any change can run it.
  "api-guards": {
    cmd: [
      "bun",
      "test",
      ...bailBun,
      ...bunTestFlags,
      ...(fileFilter
        ? fileArg
        : [
            "src/tests/raw-fetch-discipline.test.ts",
            "src/tests/no-stripe-imports.test.ts",
            // Every org link built through orgPublicBaseUrl (a source scan).
            "src/tests/no-raw-base-url.test.ts",
            // The image entrypoint: migrate-on-start flag, the `migrate`
            // one-shot, and SIGTERM reaching the exec'd server. A `bun` shim
            // on PATH, no database.
            "scripts/entrypoint.test.ts",
            // The one-off api scripts' own tests (the test map sends
            // apps/api/scripts/** here): the queue-class rollback (Redis), the
            // cron fan-out rollback (Redis) and the prompt-size probe (pure).
            "scripts/kernel-queues-rollback.test.ts",
            "scripts/cron-fanout-rollback.test.ts",
            "scripts/measure-prompt-size.test.ts",
            "src/tests/imports.test.ts",
            "src/tests/control-plane-env-matrix.test.ts",
            // P4c-T18: the thread-creation census (a pure source scan, no
            // database) and the DM row-delta invariant it stands guard
            // with (integration — POST /threads/dm must never grow the
            // `threads` table on a repeat resolution). `unit` already
            // globs src/modules wholesale so both run there too, but the
            // wiring rule is explicit: a bundled/guard test no suite names
            // ran in none, so it is named here as well.
            "src/modules/threads/thread-creation-census.test.ts",
            "src/modules/threads/dm-row-delta.test.ts",
            // P4c-T47: the api half of the retired-vocabulary sweep. A pure
            // source scan, no database. Its web twin
            // (apps/web/src/lib/retired-vocabulary.test.ts) needs vitest and
            // is covered by `web-unit`, which globs apps/web/src wholesale.
            "src/tests/retired-vocabulary.test.ts",
            // A tool's scopes live in requiredScopes only: every manifest in the
            // tree, and every `scope` read in api, web, package and bundled-app
            // source. Pure file reads, no database, so a bundled-app or SDK edit
            // can run them in a second.
            "src/modules/apps/tool-required-scopes-guard.test.ts",
            "src/modules/apps/tool-scope-read-oracle.test.ts",
            // the monitoring notification group lists the incident kinds
            // by name; this reads the monitoring manifest (pure fs, no database)
            // so a manifest-only edit, which the test map sends to this suite,
            // still runs the drift guard.
            "src/modules/notifications/monitoring-group.test.ts",
          ]),
    ],
    cwd: path.join(ROOT, "apps/api"),
  },
  // apps/db-gate, the read-only SQL gate the `database` connector talks to. It
  // is an app rather than a package, so the workspace globs above miss it and
  // every apps/api|web suite roots away from it: its 26 tests, including the
  // catalog allowlist that decides what a connector may read, ran in no suite
  // at all. It needs Postgres, which the `--env-file` the runner passes every
  // bun suite supplies (DATABASE_URL -> liaison_test).
  "db-gate": {
    cmd: ["bun", "test", ...bailBun, ...bunTestFlags, ...fileArg],
    cwd: path.join(ROOT, "apps/db-gate"),
  },
}

// EVERY `bun test` suite carries an explicit --timeout. bun 1.3.11 does NOT
// honour `[test] timeout` in bunfig.toml (both bunfig files set 60000 and bun
// ignores them), so an un-flagged suite silently runs at bun's 5 s default: a
// 91-minute sweep produced 435 failures of which 307 were nothing but that
// default. Setting it here rather than in each entry means a new suite cannot
// be added without it. Entries that already name their own cap (desktop 600 s,
// demo-seed 180 s, mobile 120 s) keep it.
const BUN_TEST_TIMEOUT_MS = 60000
for (const config of Object.values(SUITES)) {
  if (config.cmd[0] !== "bun" || config.cmd[1] !== "test") continue
  if (!config.cmd.includes("--timeout")) {
    config.cmd.splice(2, 0, "--timeout", String(BUN_TEST_TIMEOUT_MS))
  }
  // Published to the suite as well as passed to bun, because test helpers that
  // bound their own waits have to land BELOW it: a helper whose bound equals
  // bun's cap can never report anything, bun kills the test first and the run
  // says only that a case timed out. Read back from the command so an entry
  // naming its own cap publishes that one.
  const flag = config.cmd.indexOf("--timeout")
  const effective = config.cmd[flag + 1] ?? String(BUN_TEST_TIMEOUT_MS)
  config.env = { ...(config.env ?? {}), BUN_TEST_TIMEOUT_MS: effective }
}

// ── Composite suite: full ──────────────────────────────────────────────
if (suite === "full") {
  const FULL_ORDER = [
    "unit",
    "shared",
    "workspace-packages",
    "app-ui-ui",
    "bundled-ads-ui",
    "bundled-invoicing-ui",
    "bundled-social-ui",
    "bundled-boxtal-ui",
    "bundled-monitoring-ui",
    "mailbox-crypto",
    "integration",
    "integration-extra",
    "integration-mocked",
    "e2e-parallel",
    "cell",
    "web-unit",
    "playwright",
    "security",
    // P8-FX7 (D7): `worker-env` exists, the slice close gate runs it, and a
    // FULL run reached it nowhere, so packages/test-helpers was covered by a
    // suite no full order named.
    "worker-env",
    "unsplit-logins",
    "bundled-ads",
    "bundled-shopify",
    "bundled-invoicing",
    "bundled-boxtal",
    "bundled-monitoring",
    "bundled-pennylane",
    "bundled-calls",
    "bundled-social",
    "bundled-freeze",
    "report-skills",
    "guards",
    "api-guards",
    "db-gate",
    "root",
    "desktop",
    "desktop-ui",
    "mobile",
    "demo-seed",
  ]
  let allPassed = true
  const results: { name: string; code: number; dir: string }[] = []

  // A fresh copy of the template for this namespace, once, before all suites.
  console.log("▸ Cloning the test database for this namespace...")
  await prepareDb(true)
  const cleanup = cleanupInBackground()
  console.log("")

  for (const name of FULL_ORDER) {
    // Terminate lingering connections to OUR database from the previous suite.
    await terminateConnections(COORDS, COORDS.dbName).catch(() => {})

    const subEnv: Record<string, string | undefined> = {
      ...process.env,
      ...MEM_ENV,
      LIAISON_TEST_LOCK_HELD: "1",
      LIAISON_TEST_NS_HELD: "1",
    }
    delete subEnv.DATABASE_URL
    delete subEnv.NODE_ENV
    // The namespace (and its DATABASE_URL) goes to the child explicitly.
    Object.assign(subEnv, NS_ENV)
    if (guardTripped) break
    const proc = Bun.spawn({
      cmd: ["bun", "run", import.meta.path, name],
      cwd: ROOT,
      env: subEnv,
      stdout: "inherit",
      stderr: "inherit",
    })
    currentChild = proc
    currentChildPid = proc.pid
    const code = await proc.exited
    currentChild = null
    currentChildPid = null
    const ts = new Date().toISOString().replace(/[T:]/g, "-").replace(/\..+/, "").slice(0, 19)
    results.push({ name, code, dir: `logs/${ts}_${name}` })
    if (code !== 0) allPassed = false
    // A failing suite is a result, not a stop: the summary is the point. Only
    // the memory guard ends the sequence early.
    if (!shouldContinueFullRun({ code, guardTripped })) break
  }
  await cleanup

  console.log("\n══════════════════════════════════════════")
  if (guardTripped) {
    console.log("  test:full STOPPED BY THE MEMORY GUARD, suites below are partial")
    console.log("══════════════════════════════════════════")
  }
  console.log("  test:full summary")
  console.log("══════════════════════════════════════════")
  for (const r of results) {
    const icon = r.code === 0 ? "✓" : "✗"
    console.log(`  ${icon} ${r.name.padEnd(16)} exit ${r.code}`)
  }
  console.log("══════════════════════════════════════════")
  process.exit(allPassed ? 0 : 1)
}

const config = SUITES[suite]
if (!config) {
  console.error(`Unknown suite: ${suite}. Available: ${Object.keys(SUITES).join(", ")}, full`)
  process.exit(1)
}

// A suite whose every test file is declared pending is SKIPPED, not failed:
// `bun test` treats a path it cannot find as a filter that matches nothing and
// exits 1, so the entry would otherwise be a standing failure that no branch
// can fix without deleting the entry the owning branch needs. See
// `scripts/lib/pending-suites.ts`; `scripts/test-run.suites.test.ts` keeps the
// declaration honest.
// A dry run reports the command FIRST, pending or not: the guards that read a
// suite's command (the per-test timeout, above all) must keep covering a suite
// that is only waiting for its files, or un-pending it would be the moment its
// command stopped being checked.
if (DRY_RUN) {
  console.log(`cmd: ${config.cmd.join(" ")}`)
  console.log(`cwd: ${path.relative(ROOT, config.cwd)}`)
  console.log(`env: BUN_JSC_useOMGJIT=${JSC_ENV.BUN_JSC_useOMGJIT}`)
}

const pendingFiles = namedTestFiles(config.cmd)
const pendingReason = pendingSuiteReason(suite, pendingFiles, (f) =>
  existsSync(path.join(config.cwd, f)),
)
if (pendingReason) {
  console.log(`▸ Skipping ${suite}: pending: ${pendingReason}`)
  for (const f of pendingFiles) console.log(`  pending file: ${f}`)
  process.exit(0)
}

if (DRY_RUN) process.exit(0)

const ts = new Date().toISOString().replace(/[T:]/g, "-").replace(/\..+/, "").slice(0, 19)
const runDir = path.join(LOGS, `${ts}_${suite}`)
const { mkdirSync } = await import("node:fs")
mkdirSync(runDir, { recursive: true })
// The guard armed before this directory existed. Point its trip report here so
// `memory-guard-tripped.json` lands next to the suite's own output.log.
memGuard?.setLogDir(runDir)

const logFile = path.join(runDir, "output.log")

// Suites that share Postgres + Redis + Meili across runs (parallel scenario
// pool, full DB-touching scenario suite, browser-end-to-end) need a clean
// substrate per run. Bake the reset in so we never depend on the caller
// remembering — drift from previous runs (stale rate-limit counters,
// per-worker Meili indices that crowd top-N search results, kernel rows
// from a previous shape) was the source of multiple flake classes.
const NEEDS_CLEAN_SUBSTRATE = CLEAN_SUBSTRATE_SUITES
// Suites with no substrate at all: no database to prepare, no preflight (see
// the preflight note below). `root` and `guards` are file reads and small spawns,
// so a hosted runner with no services and no .env.test can run them.
const NO_SUBSTRATE = new Set(["desktop", "desktop-ui", "root", "guards"])
let cleanup: Promise<void> = Promise.resolve()
if (NEEDS_CLEAN_SUBSTRATE.has(suite)) {
  console.log(
    `▸ Pretest reset for ${suite} (namespace ${NS}): template clone + own Redis/Meili keys`,
  )
  // 1. Redis: drop this namespace's keys (queues, rate-limit counters, sessions)
  //    and nobody else's. Redis is shared by every checkout and every dev server.
  try {
    const removed = await sweepRedisPrefix(COORDS.redisUrl, COORDS.redisPrefix)
    if (removed > 0) console.log(`  Redis: unlinked ${removed} ${COORDS.redisPrefix}* keys`)
  } catch (err) {
    console.warn("  redis namespace sweep skipped:", err)
  }
  // 2. Postgres: a fresh copy of the migrated template (no migration replay).
  await prepareDb(true)
  // 3. Meilisearch: drop this namespace's indices. Indices outlive the
  //    database and accumulate docs across runs, which crowds top-N search
  //    results (search-permissions polls for its 5 fresh tickets in the top 50).
  try {
    const auth = { Authorization: `Bearer ${COORDS.meiliKey}` }
    const names = namespaceMeiliIndexes(COORDS)
    // A lookup by name is a cheap 404 when absent and enqueues no task; only
    // the indices that exist are deleted.
    const existing = (
      await Promise.all(
        names.map(async (uid) => {
          const r = await fetch(`${COORDS.meiliHost}/indexes/${uid}`, { headers: auth })
          await r.body?.cancel()
          return r.ok ? uid : null
        }),
      )
    ).filter((uid): uid is string => uid !== null)
    await Promise.all(
      existing.map((uid) =>
        fetch(`${COORDS.meiliHost}/indexes/${uid}`, { method: "DELETE", headers: auth }),
      ),
    )
    if (existing.length > 0)
      console.log(`  Meili: dropped ${existing.length} ${COORDS.meiliPrefix}* indices`)
  } catch (err) {
    console.warn("  Meili index sweep skipped:", err)
  }
  cleanup = cleanupInBackground()
  console.log("  pretest reset done")
} else if (!NO_SUBSTRATE.has(suite)) {
  // Reused as long as it was cloned from the current migrations.
  await prepareDb(false)
  cleanup = cleanupInBackground()
}

// Substrate preflight — fail LOUD with exact remediation if a service is down,
// liaison_test isn't migrated, or required env is missing, instead of letting
// tests fail mysteriously. Runs as a subprocess with --env-file so it sees the
// test env (the orchestrator process may not). Cached (PREFLIGHT_TTL_MS) so
// per-suite re-runs are near-free; SKIP_PREFLIGHT=1 bypasses. Runs AFTER any
// substrate reset above so a just-reset DB validates cleanly.
//
// SUITES WITH NO SUBSTRATE AT ALL (P6d-FX2, SK-7). apps/desktop is a Tauri
// shell, a Bun sidecar and their release scripts: nothing in either half opens
// Postgres, Redis or Meili, and the preflight aborted the whole run on a box
// where none of them is up. That made the desktop gate figure unreproducible
// by anyone who did not happen to have the API's substrate running, which is
// how a recorded figure becomes a figure nobody can check.
if (!NO_SUBSTRATE.has(suite)) {
  // Strip DATABASE_URL / NODE_ENV before handing env to preflight, for the same
  // reason the test child does below (see childEnv): the orchestrator is launched
  // via `bun run`, which auto-loads the repo-root `.env` (DATABASE_URL→liaison_dev,
  // NODE_ENV→development) into THIS process. Bun's `--env-file` does not override
  // an already-present env var, so without stripping, preflight inherits
  // liaison_dev and validates the wrong database — aborting the whole run on a box
  // where only liaison_test exists. Stripping lets `--env-file=.env.test` set them.
  const preflightEnv: Record<string, string | undefined> = { ...process.env, ...(config.env ?? {}) }
  delete preflightEnv.DATABASE_URL
  delete preflightEnv.NODE_ENV
  Object.assign(preflightEnv, NS_ENV)
  const pf = Bun.spawnSync({
    cmd: ["bun", `--env-file=${ENV_FILE}`, path.join(ROOT, "scripts/preflight.ts")],
    cwd: ROOT,
    env: preflightEnv,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (pf.exitCode !== 0) {
    failPreflight(`\n▸ Aborting ${suite}: substrate preflight failed (see above).`)
  }
}

console.log(`▸ Running ${suite} → ${runDir}/`)

// Strip DATABASE_URL so `bun test` loads .env.test (not the parent's .env which
// points to liaison_dev). Bun's .env.test auto-loading only works when the env
// var isn't already set by the parent process.
const childEnv = {
  ...process.env,
  ...MEM_ENV,
  ...JSC_ENV,
  FORCE_COLOR: "1",
  LOG_DIR: runDir,
  ...(config.env ?? {}),
}
delete childEnv.DATABASE_URL
// Delete NODE_ENV so bun test loads it from .env.test (NODE_ENV=test).
// Without this, the parent's .env (NODE_ENV=development) leaks into the child,
// preventing .env.test from overriding it — which breaks test-only bypasses
// (rate limiter, OIDC HTTPS validation, etc.).
delete childEnv.NODE_ENV
// The namespace's coordinates. Set AFTER the deletes above and passed before
// `--env-file`, which never overrides a value already present. Computed from
// the child's own environment, so a suite's env (unsplit-logins) reaches it.
Object.assign(childEnv, namespaceEnv(COORDS, childEnv))

// Load .env.test deterministically for bun-test suites via --env-file (see
// ENV_FILE note). vitest/playwright suites resolve env through their own
// mode/config, so only the `bun test …` commands get the flag.
const spawnCmd =
  config.cmd[0] === "bun" && config.cmd[1] === "test"
    ? [config.cmd[0], config.cmd[1], `--env-file=${ENV_FILE}`, ...config.cmd.slice(2)]
    : config.cmd

const proc = Bun.spawn({
  cmd: spawnCmd,
  cwd: config.cwd,
  env: childEnv,
  stdout: "pipe",
  stderr: "pipe",
})
currentChild = proc
currentChildPid = proc.pid

const file = Bun.file(logFile)
const writer = file.writer()

// biome-ignore lint: simple regex for ANSI stripping
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g

async function pipe(stream: ReadableStream<Uint8Array>, _prefix: "" | "stderr") {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      writer.write(text.replace(ANSI_RE, ""))
      process.stdout.write(text) // colored terminal output
    }
  } catch {}
}

await Promise.all([pipe(proc.stdout, ""), pipe(proc.stderr, "stderr")])
writer.end()

const code = await proc.exited
currentChild = null
currentChildPid = null
await cleanup
memGuard?.stop()
console.log(`\n▸ ${suite} exited ${code} → ${runDir}/`)
process.exit(code)
