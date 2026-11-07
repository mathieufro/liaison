// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The nightly reset: put the reserved org back, and collect the visitor orgs
// whose time is up.
//
// ── WHERE IT RUNS, AND WHY ─────────────────────────────────────────────────
// In the product's own scheduler (`registerScheduledJob`, kernel-jobs.ts),
// alongside the session cleanup and the audit retention sweep, and NOT in a
// crontab on the box. Three reasons, in order of weight:
//
//   * the work is ordinary product work. It re-seeds an org and deletes expired
//     ones; both are things the api already knows how to do, in process, with
//     the same database handles, the same logger and the same leader election
//     every other scheduled job runs under. A host crontab would have to shell
//     into the container to reach any of it.
//   * a crontab is invisible to the deployment. The demo deploy ships an image
//     and a compose file; a crontab lives beside them, is not versioned with
//     them, and survives a teardown that removes everything else. A scheduled
//     job is part of what is deployed.
//   * there is a standing preference against wrapping a job in a tool to make
//     it runnable. Registering it as a job is the shape that needs no wrapper:
//     it fires on its own, and an operator who wants it now runs the seed
//     script directly (`bun run demo:seed`), which is the same code path.
//
// The registration itself is gated on `LIAISON_DEMO_MODE`, so a normal
// deployment does not gain a scheduler, a queue entry or a query.
//
// ── EVERY DESTRUCTIVE ENTRY POINT IS GATED, ON THE STORED ROW ──────────────
// Nothing in this file deletes a row until `assertDestructionAllowed` has said
// so, and it says so only when demo mode is on for THIS process AND the org
// carries a demo marker it re-read STRAIGHT OUT OF POSTGRES (never the request
// path cache, never a value the caller handed in). That guard sits at the head
// of `deleteOrgRows`, which is the single statement executor both the purge and
// the content reset go through, so there is no way to reach a DELETE around it.
//
// This is not theoretical tidiness. `resetDemoOrgContent` is reachable from
// `liaison seed --tier demo --slug <anything>`, which ships inside the
// production api image. Before the guard existed, that command pointed at a
// real tenant's slug emptied the tenant. The row scoping was never the hole
// (every DELETE is `WHERE org_id = $1::uuid` against a catalog filtered list);
// WHICH org was.
//
// `purgeDemoOrg` keeps its own stricter guard on top: the marker must parse,
// its variant must be `visitor`, and its `expiresAt` must be in the past. A
// malformed marker fails the parse and is refused rather than throwing. A
// refusal is logged and the run continues. The purge is bounded
// (`DEMO_REAP_MAX_PER_RUN` per batch, drained batch by batch within a time
// budget, hourly) so a bad day deletes a bounded batch at a time
// before an operator can look, and every org it touches is named in the log.
//
// ── THE PURGE ITSELF IS SHARED ─────────────────────────────────────────────
// Deleting a workspace (every row in `kernel` and `app_*`, the search index,
// Redis, the job schedulers, object storage, the org row, the runtimes) is the
// org purge core in modules/org/purge/, which an operator's org deletion runs
// too. This file keeps what is demo only: the guards, which orgs the reaper
// picks, and the content reset's rules.
//
// ── AND WHY THE CONTENT RESET IS RULE DRIVEN, EXHAUSTIVELY ─────────────────
// A content reset cannot be "every table with an `org_id`": it has to leave the
// org, its people and its installed apps standing. It used to be an ALLOWLIST
// of five kernel tables, and an allowlist is exactly how a reset comes to clear
// five tables out of sixty three. An org that is re-seeded nightly could leave
// behind a routine that fires every night for ever, an MCP connection, an OAuth
// provider, an agent memory, a skill and a spend ledger, and none of it was
// ever cleared.
//
// So every org scoped table in `kernel` now carries an explicit rule
// (`KERNEL_RESET_RULES`), and a table the catalog has and the rules do not
// FAILS THE RESET LOUDLY, before a single row is deleted: a migration that adds
// a table and forgets this map breaks the reset visibly instead of silently
// leaking that table for ever. `demo-reset.integration.test.ts` asserts the
// catalog and the rules agree, so the loud failure normally lands on the author
// in CI rather than on the box at 03:15. The `app_*` schemas stay catalog driven and are cleared WHOLE: every
// row in them is domain data the seeder writes again, so a new app table is
// covered the day it exists and needs no rule.
//
// ── IMMUTABLE APP TABLES (LEGAL RECORDS) ───────────────────────────────────
// Both the purge and the content reset clear the immutable app tables (an
// issued invoice's legal original) like every other app table, through the one
// narrow exception the kernel trigger grants (modules/apps/ddl.ts): it honours
// the purge setting for a demo-marked org, which the guard below re-reads from
// Postgres first, so no other org's legal records are touched.

import os from "node:os"
import { type DemoOrgMarker, demoOrgMarkerSchema, isDemoOrgExpired } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { getPoolGauges } from "~/db/pool-diag"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { forgetDemoFixtureCrm } from "~/modules/demo/api-connector/responder"
import { countVisitorOrgs, listExpiredDemoOrgs } from "~/modules/demo/demo-expiry"
import { leadForDemoOrg } from "~/modules/demo/demo-leads"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { demoPoolStateOf, invalidateDemoMarker, visitorMarker } from "~/modules/demo/demo-org"
import { reservedOwner, seedDemoOrgData } from "~/modules/demo/demo-seeder"
import { ReapPacer, type ReapPacerOptions, type ReapPressure } from "~/modules/demo/reap-pacer"
import { forwardPlayedScenarios } from "~/modules/liaison-team/lead-forwarding"
import type { OrgExternalStateDeps } from "~/modules/org/purge/external"
import { purgeOrg } from "~/modules/org/purge/purge-org"
import {
  deleteOrgRows,
  type ExecuteTx,
  type OrgScopedTable,
  orgScopedTables,
} from "~/modules/org/purge/rows"
import { reindexOrg } from "~/modules/search/reindex"

/** The kernel schema, through the prefix a test lane runs under (db/schema-ref.ts). */
const K = () => drizzleSql.raw(schemaRef("kernel"))

const log = rootLogger.child({ module: "demo-reset" })
/** This module's logger, so a test can read the reap pass's summary line. */
export const demoResetLog = log

/** Nightly, at 03:15. Before the audit retention sweep at 04:00, after the
 *  session cleanup at 03:00, and in the quietest hour a public box has. */
export const DEMO_RESET_CRON = "15 3 * * *"

/** Ceiling on how many visitor orgs one run may delete. */
export const DEMO_REAP_MAX_PER_RUN = 25

/** Why a purge was refused. Every value here means "the org was left alone". */
export type PurgeRefusal =
  | "not-a-demo-org"
  | "malformed-marker"
  | "not-a-visitor-org"
  | "not-expired"
  | "pooled"
  | "no-such-org"

export interface PurgeResult {
  purged: boolean
  refusal?: PurgeRefusal
  /** Rows deleted, per table, when the purge went ahead. */
  deleted?: Record<string, number>
}

// ── THE GUARD ──────────────────────────────────────────────────────────────

/** Why a destructive demo operation refused to touch an org. */
export type DestructionRefusal = "demo-mode-off" | "no-such-org" | "not-a-demo-org"

/**
 * Thrown, never returned: a caller that asked to empty the wrong org must not
 * be able to carry on as though it had emptied the right one.
 */
export class DemoOrgGuardError extends Error {
  readonly refusal: DestructionRefusal
  readonly orgId: string
  constructor(refusal: DestructionRefusal, orgId: string, what: string) {
    super(`${what}: refused for org ${orgId} (${refusal})`)
    this.name = "DemoOrgGuardError"
    this.refusal = refusal
    this.orgId = orgId
  }
}

interface StoredOrgRow {
  slug: string
  marker: DemoOrgMarker | null
  /** A marker is present but does not parse. */
  malformed: boolean
}

/**
 * The org's slug and its demo marker, read STRAIGHT OUT OF POSTGRES. Never the
 * request-path cache in demo-org.ts: a cache is a value some other code path
 * wrote, and the whole point of this read is to trust nothing but the row.
 */
async function readStoredOrg(orgId: string): Promise<StoredOrgRow | null> {
  const row = await withSystemDb("demo-org-guard-read", async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT slug, settings->'demo' AS demo
      FROM ${K()}.organizations WHERE id = ${orgId}::uuid
    `)
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    return rows[0] as { slug: string; demo: unknown } | undefined
  })
  if (!row) return null
  const raw = typeof row.demo === "string" ? JSON.parse(row.demo) : row.demo
  if (raw === null || raw === undefined) {
    return { slug: String(row.slug), marker: null, malformed: false }
  }
  const parsed = demoOrgMarkerSchema.safeParse(raw)
  return {
    slug: String(row.slug),
    marker: parsed.success ? parsed.data : null,
    malformed: !parsed.success,
  }
}

/**
 * May this process delete rows from this org? Only when demo mode is on AND the
 * org row itself carries a demo marker that parses.
 *
 * A malformed marker counts as NOT a demo org here, deliberately: an operator's
 * hand written jsonb is not evidence that a workspace is disposable.
 */
async function assertDestructionAllowed(orgId: string, what: string): Promise<DemoOrgMarker> {
  if (!isDemoModeEnabled()) throw new DemoOrgGuardError("demo-mode-off", orgId, what)
  const stored = await readStoredOrg(orgId)
  if (!stored) throw new DemoOrgGuardError("no-such-org", orgId, what)
  if (!stored.marker) throw new DemoOrgGuardError("not-a-demo-org", orgId, what)
  return stored.marker
}

/** Every org scoped kernel table, as the catalog has it. */
export async function kernelOrgScopedTableNames(): Promise<string[]> {
  return withSystemDb("demo-reset-kernel-catalog", async (tx) =>
    (await orgScopedTables(tx as never, "all"))
      .filter((t) => t.schema === "kernel")
      .map((t) => t.table),
  )
}

// ── THE RULES ──────────────────────────────────────────────────────────────

/**
 * What a content reset does with one org scoped kernel table.
 *
 *  - `clear`   the reset deletes this org's rows. The seeder writes back
 *              whatever the demo is supposed to contain.
 *  - `restore` the rows stay, and the seed that follows converges them. This is
 *              for the org's own furniture, whose ids other rows and other
 *              boxes hold: deleting it would rotate every id every night.
 *  - `keep`    the rows stay and nothing restores them, on purpose. Only
 *              bookkeeping a reset has no business rewriting.
 */
export type KernelResetRule = "clear" | "restore" | "keep"

/**
 * EVERY org scoped table in the `kernel` schema, with what the nightly reset
 * does to it. A table the catalog has and this map does not stops the reset
 * (see `kernelContentTables`), so adding a table and forgetting this map is a
 * red test and a refused reset, never a silent leak.
 *
 * The bias is `clear`. A demo box hands a stranger an admin account, so
 * anything a stranger can write is content, including the surfaces that read as
 * configuration: a routine keeps firing every night after its author has gone,
 * an `mcp_connections` row and an `oauth_providers` row are durable egress and
 * auth surfaces, and `sessions` is cleared FIRST so a visitor writing during
 * the sweep is disconnected rather than racing it. `credit_transactions` is the
 * documented exception: see its entry below.
 */
export const KERNEL_RESET_RULES: Record<string, KernelResetRule> = {
  // The org's furniture. Ids other rows hold; the seed converges the contents.
  // `organizations` itself is not here: it has no `org_id` column, so it is not
  // an org scoped table, and only `purgeDemoOrg` ever deletes it.
  users: "restore",
  user_roles: "restore",
  roles: "restore",
  apps: "restore",
  // Role agents are rewritten on every seed (`onConflictDoUpdate` in
  // seed-org.ts), and personal agents are adopted by id on purpose: a thread,
  // an approval and a run all point at one.
  agents: "restore",
  // The org layer reinstalls the Shopify fixture connection and resets its
  // write overlay; deleting the row would strand that reset.
  connected_accounts: "restore",
  // Zeroed explicitly by `resetDemoOrgContent`, not deleted: the balance row is
  // the org's, and a demo org's balance must be zero rather than absent.
  credit_balances: "restore",

  // Per-org bookkeeping a reset has no business rewriting.
  agent_migration_ledger: "keep",
  // The last-applied record of `liaison config apply` (0243): the operator's
  // provisioning history, which a demo reset does not rewrite.
  config_applied_fields: "keep",
  // The token ledger the reserved org's ceiling sums over a ROLLING 24 HOURS.
  // Clearing it made the job that enforces the ceiling the job that erases it:
  // the window became "since 03:15, or 24 hours, whichever is shorter", and a
  // reviewer could burn the full allowance either side of the boundary for
  // twice the intended spend in a night. Keeping the rows costs nothing (the
  // window predicate rides an index the table already has) and nothing here
  // reads them as configuration. The showcase argument for clearing them was
  // about visitor orgs, which have no ceiling at all (they spend only their own
  // key) and are PURGED rather than reset when they expire, so no visitor ever
  // sees another visitor's ledger.
  credit_transactions: "keep",
  // A device's push address, registered once when App Review signs in on the
  // phone. Clearing it every night left the reviewer's device unreachable the
  // morning after, so "ask the agent to message you in one minute" (the push
  // path the review notes name) delivered nothing until a re-sign-in. The rows
  // hang off `users`, which is `restore`, so their user ids stay valid; the
  // reset runs only on the reserved org (visitor orgs are purged whole).
  push_tokens: "keep",
  // The same reviewer's other notification devices (desktop app, browser) and
  // their receipt credentials, for the same reason.
  desktop_devices: "keep",
  browser_push_subscriptions: "keep",
  notification_device_credentials: "keep",
  // The instance-wide active app version (org_id is reserved for per-org
  // installs and always NULL today): a demo reset must never move it.
  apps_active_version: "keep",
  // The installed app versions (org_id marks an org-private custom app, which
  // the demo never installs): a demo reset must never uninstall code.
  apps_installed: "keep",
  // The billing status the control plane pushes (managed edition only; a
  // demo server has none): not content a reset rewrites.
  org_billing_state: "keep",
  // The org moves this instance took part in (0270): transfer ids and
  // directions only, written by the transfer import/export, never by a visitor.
  // The reverse-move rule reads them, so a reset must not forget a move.
  org_transfer_ledger: "keep",

  // Everything else is content.
  sessions: "clear",
  agent_knowledge_pointers: "clear",
  agent_local_claims: "clear",
  agent_memory: "clear",
  agent_runs: "clear",
  // A visitor's durable agent turns, their step journals and the effect ledger
  // of their tool calls (0225, 0226): tool results, so the visitor's content.
  agent_turns: "clear",
  agent_turn_events: "clear",
  effect_ledger: "clear",
  agent_skill_index: "clear",
  agent_thread_checkpoints: "clear",
  app_scope_grant_audit: "clear",
  app_seeded_assets: "clear",
  app_sequences: "clear",
  approval_policies: "clear",
  approval_requests: "clear",
  // Per-org request-N counter (0215): restarts with the approvals it numbered.
  approval_handle_counters: "clear",
  approved_handler_executions: "clear",
  attention_events: "clear",
  // A visitor's away records and the app features they switched go with them.
  away_ranges: "clear",
  org_app_features: "clear",
  notification_deliveries: "clear",
  notification_receipts: "clear",
  resource_grants: "clear",
  // The local node (0127, 0140): a visitor's node registration, its connected
  // intervals, jobs, sessions (events and commands cascade), profiles,
  // attachments, level confirmations and capabilities are all their own content.
  node_jobs: "clear",
  node_connections: "clear",
  node_sessions: "clear",
  // A visitor's guided-tour progress: the next visitor starts every tour new.
  tour_progress: "clear",
  // Its scenarios' world-beat marks (0182) go with it, so each world beat runs
  // again for the next visitor.
  demo_world_marks: "clear",
  // Its import runs and their undo ledger (0207) are the visitor's own content.
  import_runs: "clear",
  import_ledger: "clear",
  // Its whole-org export rows (0232); the archives go with the org prefix GC.
  org_exports: "clear",
  node_level_confirmations: "clear",
  node_capabilities: "clear",
  // My node chat (0130): per-thread node settings and permission prompts.
  thread_node_settings: "clear",
  node_permission_prompts: "clear",
  node_profiles: "clear",
  node_attachments: "clear",
  nodes: "clear",
  audit_log: "clear",
  auto_approve_policies: "clear",
  // A visitor's address book entries (0253) go with the contacts.
  contact_addresses: "clear",
  contact_group_members: "clear",
  product_attributes: "clear",
  // A visitor's document templates (0255) go; their files go with the files rule.
  document_templates: "clear",
  // A visitor's needed-template rules (0256) go with them.
  document_template_rules: "clear",
  contact_segments: "clear",
  contacts: "clear",
  // Staff-marked trusted sender addresses and domains: a visitor's marks go.
  trusted_senders: "clear",
  device_flow_requests: "clear",
  disabled_app_skills: "clear",
  // Who may use a restricted app: a visitor's restriction goes; the seed puts
  // every app back to everyone (`kernel.apps` itself is restored).
  org_app_access: "clear",
  file_upload_sessions: "clear",
  files: "clear",
  // A visitor's data imports: the uploads and the transforms written for them.
  import_transforms: "clear",
  import_uploads: "clear",
  invitations: "clear",
  mailbox_client_jobs: "clear",
  mailbox_migration_state: "clear",
  mailbox_server_keys: "clear",
  mcp_connections: "clear",
  message_reactions: "clear",
  messages: "clear",
  oauth_accounts: "clear",
  oauth_providers: "clear",
  password_resets: "clear",
  pending_events: "clear",
  reply_thread_followers: "clear",
  routine_runs: "clear",
  routine_state: "clear",
  routines: "clear",
  saved_views: "clear",
  scope_disclosure_policy: "clear",
  scope_requests: "clear",
  // A visitor's secret cards (never a secret, only what was asked for).
  secret_requests: "clear",
  search_document_clusters: "clear",
  skills: "clear",
  sub_agent_definitions: "clear",
  thread_brief_marks: "clear",
  thread_briefs: "clear",
  thread_episodes: "clear",
  thread_participants: "clear",
  thread_references: "clear",
  threads: "clear",
  timeline_entries: "clear",
  user_dimension_grants: "clear",
  user_key_wraps: "clear",
  user_mailbox_identities: "clear",
  user_scope_grants: "clear",
  user_thread_state: "clear",
}

/** Thrown before anything is deleted, when the catalog has a table the rules do not. */
export class UnruledKernelTableError extends Error {
  readonly tables: string[]
  constructor(tables: string[]) {
    super(
      `demo reset: ${tables.length} org scoped kernel table(s) have no rule in ` +
        `KERNEL_RESET_RULES (${tables.join(", ")}). Add each one as 'clear', ` +
        `'restore' or 'keep' before a reset can run.`,
    )
    this.name = "UnruledKernelTableError"
    this.tables = tables
  }
}

/**
 * The tables one content reset empties: every `app_*` table the catalog knows,
 * plus the kernel tables ruled `clear`. `sessions` first, so a visitor is
 * disconnected before the rest of the sweep rather than writing into it.
 */
async function kernelContentTables(tx: ExecuteTx): Promise<OrgScopedTable[]> {
  const catalog = (await orgScopedTables(tx, "all")).filter((t) => t.schema === "kernel")
  const unruled = catalog.map((t) => t.table).filter((table) => !(table in KERNEL_RESET_RULES))
  if (unruled.length > 0) throw new UnruledKernelTableError(unruled)

  const present = new Set(catalog.map((t) => t.table))
  const stale = Object.keys(KERNEL_RESET_RULES).filter((table) => !present.has(table))
  if (stale.length > 0) {
    // A dropped table must never wedge the reset, so this is a warning and not
    // a refusal: the rule is simply unused until somebody removes it.
    log.warn({ stale }, "KERNEL_RESET_RULES names tables this database does not have")
  }

  const clear = catalog.filter((t) => KERNEL_RESET_RULES[t.table] === "clear")
  return [
    ...clear.filter((t) => t.table === "sessions"),
    ...clear.filter((t) => t.table !== "sessions"),
  ]
}

// ── THE INTERRUPTED RESET FLAG ─────────────────────────────────────────────
//
// A content reset is a clear followed by a seed, and the two are not one
// transaction (they cannot be: the seed installs apps, writes object storage
// and takes minutes). A process that dies between them used to leave the ONE
// curated workspace half emptied, with its demo marker unchanged, and the next
// night's run could not tell that from a workspace that had simply been quiet:
// it probed a thin org, got `ok`, and cleared it again.
//
// So the org says so itself. `settings.demoReset.startedAt` is written before
// the first DELETE and removed only when a re-seed has come back clean. It
// lives NEXT TO the demo marker rather than inside it, so `demoOrgMarkerSchema`
// (shared with the web app) does not have to learn about it, and reading it is
// how the next run knows to heal rather than to clear again.

export interface ResetInProgress {
  startedAt: string
}

/** Raise the flag. Called immediately before the first DELETE. */
export async function markResetInProgress(orgId: string, now: Date = new Date()): Promise<void> {
  await withSystemDb("demo-reset-flag-set", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE ${K()}.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) ||
        jsonb_build_object('demoReset',
          jsonb_build_object('startedAt', ${now.toISOString()}::text))
      WHERE id = ${orgId}::uuid
    `)
  })
}

/** Lower the flag. Called only when a re-seed has come back clean. */
export async function clearResetInProgress(orgId: string): Promise<void> {
  await withSystemDb("demo-reset-flag-clear", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE ${K()}.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) - 'demoReset'
      WHERE id = ${orgId}::uuid
    `)
  })
}

/** The raised flag, or null. This is how an interrupted reset is detected. */
export async function readResetInProgress(orgId: string): Promise<ResetInProgress | null> {
  const row = await withSystemDb("demo-reset-flag-read", async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT settings->'demoReset' AS flag
      FROM ${K()}.organizations WHERE id = ${orgId}::uuid
    `)
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    return rows[0] as { flag: unknown } | undefined
  })
  const raw = typeof row?.flag === "string" ? JSON.parse(row.flag) : row?.flag
  if (raw === null || raw === undefined || typeof raw !== "object") return null
  const startedAt = (raw as { startedAt?: unknown }).startedAt
  return typeof startedAt === "string" ? { startedAt } : null
}

/**
 * Take a demo org's platform credit away.
 *
 * The balance is real money on a managed edition, and a workspace anyone on the
 * internet can sign into as an admin must never hold any. `credit_balances` is
 * ruled `restore` by the sweep (the row is the org's, and a demo org's balance
 * must be zero rather than absent), so this is what puts it back to zero.
 *
 * It deliberately does NOT touch `credit_transactions`. That table is the
 * rolling window the reserved org's ceiling is measured over, and erasing it
 * here is how the enforcing job became the escape hatch.
 */
export async function zeroDemoOrgPlatformCredit(orgId: string): Promise<void> {
  await withSystemDb("demo-reset-zero-credit", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE ${K()}.credit_balances
      SET included_balance = 0, purchased_balance = 0
      WHERE org_id = ${orgId}::uuid
        AND (included_balance <> 0 OR purchased_balance <> 0)
    `)
  })
}

/**
 * Empty an org of its content, leaving the org, its people, its roles and its
 * agents where they are, and raise the interrupted-reset flag for the duration.
 *
 * This is what makes the nightly reset a real reset. The layer seeders are
 * idempotent (a second run creates no duplicate and grows no table) but they
 * are not self healing: a ticket is adopted by its `externalRef` and a person
 * by their address, so a subject a visitor rewrote stays rewritten however many
 * times the seeder runs. Emptying first and seeding after is what restores it.
 *
 * REFUSES, by throwing `DemoOrgGuardError`, unless demo mode is on and the org
 * carries a demo marker read out of Postgres. The caller is expected to call
 * `completeDemoOrgReset` once its re-seed has come back clean.
 */
export async function resetDemoOrgContent(orgId: string): Promise<Record<string, number>> {
  await assertDestructionAllowed(orgId, "demo-reset-content")
  // Raise the flag BEFORE the first DELETE. A crash after this line leaves a
  // workspace that says it is mid reset, which is the whole point.
  await markResetInProgress(orgId)
  const deleted = await deleteOrgRows(
    "demo-reset-content",
    orgId,
    async (tx) => [...(await orgScopedTables(tx, "apps-only")), ...(await kernelContentTables(tx))],
    // The guard again, at the row delete itself: it cannot be routed around.
    assertDestructionAllowed,
  )
  await zeroDemoOrgPlatformCredit(orgId)
  await sweepOrgSearchIndex(orgId, "demo-reset-content")
  // The fixture CRM's records written before the reset go with the rest.
  await forgetDemoFixtureCrm(orgId)
  return deleted
}

/**
 * THE SEARCH INDEX FORGETS WHAT THE DELETES REMOVED. `deleteOrgRows` is plain
 * SQL, so no entity event reaches the search indexer and every cleared row
 * keeps its document. The re-seed then creates many rows under new ids, and
 * each reset left one more copy of every seeded result in search. Rebuilding
 * the org from Postgres right after the delete prunes those documents; the
 * seed that follows indexes its own rows through the usual events.
 *
 * A failure here is logged and swallowed: a stale index is a cosmetic defect,
 * and a reset that stops halfway is not.
 */
async function sweepOrgSearchIndex(orgId: string, what: string): Promise<void> {
  try {
    const { pruned } = await reindexOrg(orgId)
    log.info({ orgId, what, pruned }, "demo org search documents swept")
  } catch (err) {
    log.error({ err, orgId, what }, "failed to sweep the demo org's search documents")
  }
}

/** Lower the interrupted-reset flag. Only after a re-seed has come back clean. */
export async function completeDemoOrgReset(orgId: string): Promise<void> {
  await clearResetInProgress(orgId)
}

/**
 * Delete ONE expired visitor demo org, or refuse. The guard is re-evaluated
 * here against the stored row, never taken from the caller, and `deleteOrgRows`
 * re-evaluates the demo marker again on its own behalf.
 */
export async function purgeDemoOrg(
  orgId: string,
  now: Date = new Date(),
  externalDeps: OrgExternalStateDeps = {},
): Promise<PurgeResult> {
  const stored = await readStoredOrg(orgId)
  if (!stored) return { purged: false, refusal: "no-such-org" }
  if (stored.malformed) return { purged: false, refusal: "malformed-marker" }
  if (!stored.marker) return { purged: false, refusal: "not-a-demo-org" }
  if (stored.marker.variant !== "visitor") return { purged: false, refusal: "not-a-visitor-org" }
  // An unclaimed warm-pool org (demo-pool.ts) has no visitor and no clock yet.
  if (demoPoolStateOf(stored.marker)) return { purged: false, refusal: "pooled" }
  if (!isDemoOrgExpired({ settings: { demo: stored.marker } }, now)) {
    return { purged: false, refusal: "not-expired" }
  }

  // The scenarios this visitor played go to the Liaison team's copy of the lead
  // while their progress still exists (queued only when that is on; never throws).
  const lead = await leadForDemoOrg(orgId)
  if (lead) await forwardPlayedScenarios(lead.id, orgId)

  // The shared org purge (modules/org/purge/): provider disconnect, every row,
  // the search documents (one filter delete), objects, Redis keys, job
  // schedulers, the org row and its runtimes in every process. Its row delete
  // re-checks the demo guard against the stored row. No settle wait (an expired
  // workspace is refused by its own gate already) and no residue gate (the
  // next reap is the retry).
  // Per-step wall clock on the collected line: what an operator sizes the
  // reaper's throughput from.
  const stepMs: Record<string, number> = {}
  let stepAt = Date.now()
  const started = stepAt
  const { deleted } = await purgeOrg(orgId, {
    reason: "demo-reset-purge",
    assertAllowed: assertDestructionAllowed,
    settle: false,
    verify: false,
    regenerateTriggers: false,
    externalDeps,
    onStep: (step) => {
      const at = Date.now()
      stepMs[step] = (stepMs[step] ?? 0) + (at - stepAt)
      stepAt = at
    },
  })
  await invalidateDemoMarker(orgId)
  await forgetDemoFixtureCrm(orgId)
  log.warn(
    { orgId, slug: stored.slug, deleted, ms: Date.now() - started, stepMs },
    "collected an expired demo workspace",
  )
  return { purged: true, deleted }
}

export interface DemoResetOutcome {
  /** Reserved orgs put back, with whether every layer landed. */
  reseeded: Array<{
    orgId: string
    slug: string
    ok: boolean
    detail?: string
    /** What this run did: cleared and re-seeded, or topped an org back up. */
    action: "reset" | "heal" | "skipped"
    /** The previous run died mid reset and this run found the flag still up. */
    healedInterrupted?: boolean
  }>
  /** Visitor orgs deleted. */
  collected: Array<{ orgId: string; slug: string }>
  /** Orgs the guard refused, and why. Empty on a normal night. */
  refused: Array<{ orgId: string; slug: string; refusal: PurgeRefusal }>
}

/**
 * Every reserved org on this box, by id and slug, oldest first.
 *
 * There is meant to be exactly ONE. Nothing in the schema enforces it, because
 * the marker is a jsonb setting an operator writes, and refusing to reset a
 * second one would leave it running rather than remove it. `runDemoReset`
 * therefore ALERTS when it finds more than one: each reserved marker carries
 * its own licence to spend the deployment's model key and its own copy of the
 * ceiling, so two of them is twice the budget with nobody having decided to
 * spend it.
 */
async function reservedOrgs(): Promise<
  Array<{ orgId: string; slug: string; name: string; locale: string }>
> {
  return withSystemDb("demo-reset-reserved", async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT id, slug, name, default_locale AS locale
      FROM ${K()}.organizations
      WHERE settings->'demo'->>'variant' = 'reserved'
      ORDER BY created_at ASC
    `)
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      orgId: String(r.id),
      slug: String(r.slug),
      name: String(r.name),
      locale: String(r.locale ?? "en"),
    }))
  })
}

/** The throwaway org one run seeds to prove the seeder before it clears anything. */
export function resetProbeSlug(reservedSlug: string): string {
  return `${reservedSlug}-reseed-probe`
}

/** Force expire a probe org's marker and collect it through the ordinary purge. */
async function dropProbeOrg(orgId: string): Promise<void> {
  const { markOrgAsDemo } = await import("~/modules/demo/demo-org")
  await markOrgAsDemo(orgId, visitorMarker(1, new Date(Date.now() - 48 * 3600_000)))
  const result = await purgeDemoOrg(orgId)
  if (!result.purged) log.warn({ orgId, refusal: result.refusal }, "reset probe org not collected")
}

/** The id behind a slug, or null. */
async function orgIdForSlug(slug: string): Promise<string | null> {
  return withSystemDb("demo-reset-probe-lookup", async (tx) => {
    const result = await tx.execute(
      drizzleSql`SELECT id FROM ${K()}.organizations WHERE slug = ${slug}`,
    )
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    const row = rows[0] as { id: string } | undefined
    return row ? String(row.id) : null
  })
}

/**
 * Prove the seeder FROM SCRATCH, in a throwaway org, and delete it again.
 *
 * The probe used to be a top up run against the reserved org itself, which is a
 * different code path from the one it was meant to prove: every layer adopts
 * the rows it already wrote and almost nothing is created, so a seeder that
 * could no longer CREATE 33 tickets still passed, and the clear that followed
 * emptied the one curated workspace on the strength of it. A scratch org
 * exercises the create path, which is exactly the path the post clear seed
 * takes, and it cannot lose anything because there is nothing in it.
 *
 * The probe org is marked as a visitor org by the seeder itself, so a run that
 * dies before deleting it leaves an org the ordinary reaper collects the next
 * night rather than a permanent squatter.
 */
async function probeSeederFromScratch(reserved: {
  slug: string
  name: string
  locale: string
}): Promise<{ ok: boolean; detail?: string }> {
  const slug = resetProbeSlug(reserved.slug)

  // A leftover from a run that died: collect it before reusing the slug, and
  // refuse the slug outright if whatever is sitting on it is not a demo org.
  const leftover = await orgIdForSlug(slug)
  if (leftover) {
    const stored = await readStoredOrg(leftover)
    if (stored?.marker?.variant !== "visitor") {
      return { ok: false, detail: `the probe slug '${slug}' is taken by a non probe org` }
    }
    await dropProbeOrg(leftover)
  }

  const seed = await seedDemoOrgData({
    orgSlug: slug,
    orgName: `${reserved.name} (reset probe)`,
    variant: "visitor",
    locale: reserved.locale,
  })
  // Resolved by SLUG, never from the seeder's own report: an id that came back
  // wrong is an id this function would then delete, and the reserved org is one
  // of the things it could be.
  const probeOrgId = await orgIdForSlug(slug)
  if (probeOrgId) await dropProbeOrg(probeOrgId)
  return { ok: seed.ok, detail: seed.detail }
}

/**
 * Every 10 minutes: the reaper alone, so expired data never waits for the
 * night. Hourly was too slow under launch load: a box taking 40 starts a minute
 * expires 2400 workspaces an hour, more than one 10 minute pass can collect.
 */
export const DEMO_REAP_CRON = "*/10 * * * *"

/**
 * Wall-clock budget for one reap pass; the next pass carries on. Shorter than
 * the cron's interval, so two passes never run at once.
 */
export const DEMO_REAP_BUDGET_MS = 8 * 60 * 1000

/**
 * The share of the budget the pacer plans to drain the backlog in: the rest is
 * margin for purges that get slower as the pass goes on.
 */
const REAP_DRAIN_SHARE = 0.8

/**
 * A workspace cap this full (the visitors' or the load lane's, expired
 * workspaces included) makes the pass urgent: no yielding, because a full cap
 * refuses every new start.
 */
const REAP_URGENT_CAP_SHARE = 0.8

/** An expired backlog this large after a pass means signups outrun the reaper. */
export const DEMO_EXPIRED_BACKLOG_ALERT = 100

/**
 * Purges one reap pass runs at once on an idle box. A purge is a chain of
 * short system transactions (one per table holding the org's rows, then Redis,
 * objects and the org row), so one at a time leaves an idle box idle between
 * round trips. On a busy box the pacer (`reap-pacer.ts`) drops to one purge
 * at a time with a rest after each, so the reaper never competes with
 * visitors for the database or the box's cores.
 */
export const DEMO_REAP_CONCURRENCY = 3
/** How long a waiting purge sleeps before looking at the pacer again. */
const REAP_YIELD_MS = 200

/** The privileged pool has waiters or is at least half busy. */
function privilegedPoolBusy(): boolean {
  const p = getPoolGauges().privileged
  return p.waiting > 0 || (p.held + p.waiting) * 2 >= p.max
}

/**
 * The pressure signals the pacer reads before each purge: this process's
 * privileged pool, the round trip of a trivial system query (pool wait plus
 * database latency), and the host's load per core.
 */
export async function sampleReapPressure(): Promise<ReapPressure> {
  const poolBusy = privilegedPoolBusy()
  let dbProbeMs: number | null = null
  const t0 = performance.now()
  try {
    await withSystemDb("demo-reap-probe", (tx) => tx.execute(drizzleSql`SELECT 1`))
    dbProbeMs = performance.now() - t0
  } catch {
    dbProbeMs = null
  }
  let hostLoadPerCore: number | null = null
  const cores = os.availableParallelism?.() ?? os.cpus().length
  const load1 = os.loadavg()[0]
  if (cores > 0 && Number.isFinite(load1) && load1 > 0) hostLoadPerCore = load1 / cores
  return { poolBusy, dbProbeMs, hostLoadPerCore }
}

/**
 * Collect expired visitor orgs: drain the WHOLE backlog in batches of
 * `DEMO_REAP_MAX_PER_RUN` until none remain, the time budget is spent, or a
 * batch makes no progress (every candidate refused or failed, so looping again
 * would spin). The per-batch cap keeps the blast radius of a bad day small; the
 * loop is what keeps expired data (including encrypted stored provider keys)
 * from accumulating faster than it is collected. Never throws.
 */
export async function reapExpiredDemoOrgs(
  now: Date = new Date(),
  opts: {
    budgetMs?: number
    externalDeps?: OrgExternalStateDeps
    /** Pressure sampler; tests inject one. */
    pressure?: () => Promise<ReapPressure>
    /** Pacer tuning; tests shorten the rests. */
    pacer?: Partial<ReapPacerOptions>
  } = {},
): Promise<Pick<DemoResetOutcome, "collected" | "refused">> {
  const out: Pick<DemoResetOutcome, "collected" | "refused"> = { collected: [], refused: [] }
  // Every pass says what it did in one info line, an early return included: a
  // pass that leaves expired workspaces in place must never be silent.
  if (!isDemoModeEnabled()) {
    log.info({ reason: "demo-mode-off" }, "demo reap pass skipped: demo mode is off")
    return out
  }
  const passStarted = Date.now()
  const deadline = passStarted + (opts.budgetMs ?? DEMO_REAP_BUDGET_MS)
  let failed = 0
  let stopped: "drained" | "out-of-time" | "no-progress" | "list-failed" = "drained"
  const attempted = new Set<string>()
  const pacer = new ReapPacer({ maxConcurrency: DEMO_REAP_CONCURRENCY, ...opts.pacer })
  const sample = opts.pressure ?? sampleReapPressure
  let restUntil = 0
  let pressuredSamples = 0
  let restedMs = 0
  // The throughput floor (reap-pacer.ts): the whole backlog is planned to be
  // drained in this pass, and the pass is urgent when a workspace cap is nearly
  // full of workspaces it could free.
  let backlog = 0
  try {
    const counts = await countVisitorOrgs(now)
    backlog = counts.expired
    pacer.setUrgent(
      counts.expired > 0 &&
        (counts.synthetic >= env.LIAISON_DEMO_SYNTHETIC_MAX_ORGS * REAP_URGENT_CAP_SHARE ||
          counts.total >= env.LIAISON_DEMO_MAX_VISITOR_ORGS * REAP_URGENT_CAP_SHARE),
    )
  } catch (err) {
    log.warn({ err }, "could not count the expired demo backlog; the pass paces per batch")
  }
  const drainBy = passStarted + (opts.budgetMs ?? DEMO_REAP_BUDGET_MS) * REAP_DRAIN_SHARE
  while (Date.now() < deadline) {
    let batch: Awaited<ReturnType<typeof listExpiredDemoOrgs>>
    try {
      batch = (await listExpiredDemoOrgs(now, DEMO_REAP_MAX_PER_RUN + attempted.size)).filter(
        (o) => !attempted.has(o.orgId),
      )
    } catch (err) {
      log.error({ err }, "failed to list expired demo workspaces")
      stopped = "list-failed"
      break
    }
    batch = batch.slice(0, DEMO_REAP_MAX_PER_RUN)
    if (batch.length === 0) break
    let progressed = false
    // Paced: at most pacer.concurrency() purges in flight, and while the box is
    // under pressure one at a time with a rest after each (reap-pacer.ts).
    const running = new Set<Promise<void>>()
    let outOfTime = false
    for (const [i, org] of batch.entries()) {
      pacer.schedule(Math.max(backlog - attempted.size, batch.length - i, 1), drainBy - Date.now())
      // The rest earned by the last purge, then a fresh pressure sample.
      while (Date.now() < restUntil && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.min(restUntil - Date.now(), 5_000)))
      }
      if (Date.now() < deadline && pacer.observe(await sample())) pressuredSamples++
      while (running.size >= pacer.concurrency() && Date.now() < deadline) {
        await Promise.race([...running, new Promise((r) => setTimeout(r, REAP_YIELD_MS))])
      }
      if (Date.now() >= deadline) {
        outOfTime = true
        break
      }
      attempted.add(org.orgId)
      const startedAt = Date.now()
      const task: Promise<void> = purgeDemoOrg(org.orgId, now, opts.externalDeps)
        .then(
          (result) => {
            if (result.purged) {
              progressed = true
              out.collected.push({ orgId: org.orgId, slug: org.slug })
            } else {
              out.refused.push({
                orgId: org.orgId,
                slug: org.slug,
                refusal: result.refusal ?? "not-a-demo-org",
              })
              log.warn(
                { orgId: org.orgId, slug: org.slug, refusal: result.refusal },
                "purge refused",
              )
            }
          },
          (err) => {
            failed++
            log.error(
              { err, orgId: org.orgId, slug: org.slug },
              "failed to collect a demo workspace",
            )
          },
        )
        .finally(() => {
          running.delete(task)
          const rest = pacer.restAfter(Date.now() - startedAt)
          if (rest > 0) {
            restedMs += rest
            restUntil = Math.max(restUntil, Date.now() + rest)
          }
        })
      running.add(task)
    }
    await Promise.all(running)
    if (outOfTime || !progressed) {
      stopped = outOfTime ? "out-of-time" : "no-progress"
      break
    }
  }
  if (stopped === "drained" && Date.now() >= deadline) stopped = "out-of-time"
  log.info(
    {
      expired: attempted.size,
      collected: out.collected.length,
      refused: out.refused.length,
      failed,
      stopped,
      ms: Date.now() - passStarted,
      backlog,
      urgent: pacer.isUrgent(),
    },
    attempted.size === 0
      ? "demo reap pass: nothing expired"
      : `demo reap pass: ${out.collected.length} of ${attempted.size} expired collected`,
  )
  if (pressuredSamples > 0) {
    log.info(
      {
        collected: out.collected.length,
        pressuredSamples,
        restedMs,
        duty: pacer.currentDuty(),
      },
      "demo reap pass paced: yielded to live traffic",
    )
  }
  // Each purge released its org's runtime in every process (org-runtime:release).
  try {
    const { expired } = await countVisitorOrgs(now)
    if (expired >= DEMO_EXPIRED_BACKLOG_ALERT) {
      log.error(
        { expired, threshold: DEMO_EXPIRED_BACKLOG_ALERT, alert: "demo_expired_backlog" },
        "expired demo workspaces are accumulating faster than they are collected",
      )
    }
  } catch (err) {
    log.warn({ err }, "could not count the expired demo backlog")
  }
  return out
}

/**
 * The nightly run: re-seed every reserved org, then collect expired visitor
 * orgs. Never throws: a failure in either half is logged and the other half
 * still runs, because a box that skipped its reset should still reap, and a box
 * that cannot reap should still be presentable in the morning.
 */
export async function runDemoReset(now: Date = new Date()): Promise<DemoResetOutcome> {
  const outcome: DemoResetOutcome = { reseeded: [], collected: [], refused: [] }
  if (!isDemoModeEnabled()) return outcome

  const reserved = await reservedOrgs()
  if (reserved.length > 1) {
    // The platform key licence is per marker, and so is the ceiling: a second
    // reserved org is a second budget nobody decided to spend. Nothing here
    // deletes an org an operator created, so this is said loudly instead.
    log.error(
      {
        count: reserved.length,
        slugs: reserved.map((o) => o.slug),
        alert: "demo_reserved_org_fanout",
      },
      "more than one reserved demo org exists; each one carries its own platform key licence and its own ceiling",
    )
  }
  for (const org of reserved) {
    try {
      const interrupted = (await readResetInProgress(org.orgId)) !== null
      if (interrupted) {
        log.warn(
          { orgId: org.orgId, slug: org.slug },
          "the previous content reset never finished; this run heals it",
        )
      }

      // RESOLVE THE CREDENTIAL BEFORE DELETING ANYTHING. `reservedOwner()`
      // throws when LIAISON_DEMO_REVIEWER_PASSWORD is unset, and a throw after
      // the clear would empty the one curated workspace on the box and then
      // fail to re-seed it. Asked here, a misconfigured box is a loud log line
      // and an untouched org.
      const owner = reservedOwner()

      // PROVE THE SEEDER BEFORE DELETING ANYTHING, on the code path the post
      // clear seed will actually take.
      const probe = await probeSeederFromScratch(org)

      let action: DemoResetOutcome["reseeded"][number]["action"]
      let seed: { ok: boolean; detail?: string }
      if (probe.ok) {
        const cleared = await resetDemoOrgContent(org.orgId)
        log.info({ orgId: org.orgId, slug: org.slug, cleared }, "reserved org content cleared")
        seed = await seedDemoOrgData({
          orgSlug: org.slug,
          orgName: org.name,
          variant: "reserved",
          locale: org.locale,
          // The App Review account is re-created if a clear or an operator ever
          // took it away, and `seedDemoOrgData` re-pins its password to the
          // environment afterwards, so a reviewer's credential is the same one
          // after every run as it was before.
          owner,
        })
        action = "reset"
        if (seed.ok) await completeDemoOrgReset(org.orgId)
        else {
          log.error(
            { orgId: org.orgId, slug: org.slug, detail: seed.detail },
            "reserved org was cleared and the re-seed failed; the org stays flagged",
          )
        }
      } else {
        // The seeder is not healthy, so nothing is deleted. The org is still
        // topped up: it cannot lose a row, and it is the only thing that refills
        // a workspace a previous run left half emptied.
        log.error(
          { orgId: org.orgId, slug: org.slug, detail: probe.detail },
          "skipped the content reset: a from scratch seed did not come back clean",
        )
        seed = await seedDemoOrgData({
          orgSlug: org.slug,
          orgName: org.name,
          variant: "reserved",
          locale: org.locale,
          // The App Review account is re-created if a clear or an operator ever
          // took it away, and `seedDemoOrgData` re-pins its password to the
          // environment afterwards, so a reviewer's credential is the same one
          // after every run as it was before.
          owner,
        })
        action = "heal"
        if (seed.ok && interrupted) await completeDemoOrgReset(org.orgId)
      }

      // Belt and braces, on every path: a demo org holds no platform credit and
      // carries no spend history into the next visitor's session.
      await zeroDemoOrgPlatformCredit(org.orgId)

      outcome.reseeded.push({
        orgId: org.orgId,
        slug: org.slug,
        ok: seed.ok,
        detail: seed.detail,
        action,
        ...(interrupted ? { healedInterrupted: true } : {}),
      })
      log.info({ orgId: org.orgId, slug: org.slug, ok: seed.ok, action }, "reserved org re-seeded")
    } catch (err) {
      log.error({ err, orgId: org.orgId, slug: org.slug }, "failed to re-seed a reserved org")
      outcome.reseeded.push({
        orgId: org.orgId,
        slug: org.slug,
        ok: false,
        detail: err instanceof Error ? err.message : "threw",
        action: "skipped",
      })
    }
  }

  const reaped = await reapExpiredDemoOrgs(now)
  outcome.collected.push(...reaped.collected)
  outcome.refused.push(...reaped.refused)
  log.info(
    {
      reseeded: outcome.reseeded.length,
      collected: outcome.collected.length,
      refused: outcome.refused.length,
    },
    "demo reset finished",
  )
  return outcome
}
