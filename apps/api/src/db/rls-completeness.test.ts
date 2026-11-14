// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"

// ───────────────────────────────────────────────────────────────────────────
// I-DB-3 — Dynamic RLS-completeness guard.
//
// This guard no longer uses a frozen Phase 1-2 table list (the root cause that
// hid B9, I-DB-1, I-DB-4, and m13). Instead it derives the org-scoped table set
// DYNAMICALLY: every table in `kernel` or an `app_*` schema that carries an
// `org_id` column. Any NEW org-scoped table that ships without FORCE RLS + a
// policy will fail this test automatically.
//
// Two explicit allowlists narrow the dynamic set:
//
//   PRIVILEGED_GLOBAL_TABLES — tables that legitimately do NOT participate in
//   RLS because the `liaison_rls` role has `REVOKE ALL` on them (they are
//   reached only through the privileged/admin connection). For these, FORCE RLS
//   + policy is not the protection mechanism, so they are exempt by design.
//
//   KNOWN_RLS_GAPS — tables that ARE meant to be RLS-governed but currently
//   fail FORCE-RLS and/or policy coverage. These are the genuine, already-
//   triaged gaps that Wave 2a (WS-3) will drain. Seeded with exactly today's
//   failing tables so this guard is GREEN now (CI stays unblocked) while still
//   biting on any NEW violation. Each entry is annotated with its finding ID;
//   remove the entry as part of the corresponding fix.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Tables that carry `org_id` but are intentionally NOT RLS-governed: the
 * `liaison_rls` role has `REVOKE ALL` on them, so they are only ever touched
 * through the privileged (`__privileged_db__` / `liaison_admin`) connection.
 * RLS policies are not their protection boundary — role grants are. Document
 * the reason for every entry.
 */
const PRIVILEGED_GLOBAL_TABLES = new Set<string>([
  // REVOKE ALL ... FROM liaison_rls in 0000_initial.sql:1077 — approval-handler
  // execution ledger is written/read only via withPrivilegedDb.
  "kernel.approved_handler_executions",
  // REVOKE ALL ... FROM liaison_rls in 0000_initial.sql:3389 — legacy MCP
  // connections table, accessed via liaison_app/liaison_admin only.
  "kernel.mcp_connections",
  // REVOKE ALL ... FROM liaison_rls in 0000_initial.sql — Component A's
  // first-install marker, written/read only by the privileged reconciler
  // (liaison_admin BYPASSRLS). RLS policies are not its boundary; the REVOKE is.
  "kernel.app_seeded_assets",
  // REVOKE ALL ... FROM liaison_rls in 0000_initial.sql — the app catalog's
  // active-version pointer. Its `org_id` (migration 0212) is reserved for
  // per-org installs and always NULL; written only by activation.ts.
  "kernel.apps_active_version",
  // REVOKE ALL ... FROM liaison_rls in 0000_initial.sql — the instance's
  // installed app versions. Its `org_id` (migration 0267) marks an org-private
  // custom app (managed edition) and is NULL for every instance app; read
  // through modules/apps/app-org-scope.ts and written by the install service,
  // privileged pool only.
  "kernel.apps_installed",
  // Server-held mailbox keys (migration 0229): FORCE RLS with no policy, read
  // and written only by the mailbox-crypto modules through the privileged pool.
  "kernel.mailbox_server_keys",
  // Worker modules the platform builds for code with no installed version
  // (migration 0299): FORCE RLS with no policy, REVOKE ALL from liaison_rls,
  // read and written only by modules/apps/workers/adhoc-module.ts through the
  // privileged pool.
  "kernel.app_code_modules",
])

/**
 * Org-scoped tables that SHOULD be RLS-governed but currently miss FORCE RLS
 * and/or a policy.
 *
 * Wave 2a (WS-3) DRAINED this list to empty: every former entry was fixed at
 * the source (FORCE RLS + policy in 0000_initial.sql) rather than allowlisted,
 * so the dynamic assertions below now cover those tables for real. Keep the
 * empty set so any NEW org-scoped table that ships without FORCE RLS + a policy
 * fails this guard until it is either fixed or (rarely) added here with a
 * finding ID and justification.
 */
const KNOWN_RLS_GAPS = new Set<string>([])

/**
 * Tables without org_id and without RLS: global registries the request role may
 * at most READ (asserted below). Every entry says what it holds.
 */
const GLOBAL_TABLES = new Set<string>([
  // App catalog: one row per installed bundle, the same for every org.
  "kernel.apps_installed",
  // MCP OAuth dynamic client registrations, read by the OAuth server via withSystemDb.
  "kernel.mcp_oauth_clients",
  // Sharing dispatch table read by kernel.can_manage_sharing / can_read_resource;
  // written by migrations only (0176 took back the default-privilege writes).
  "kernel.shareable_resource_types",
])

/** The global tables the request role must not be able to write. */
const GLOBAL_TABLES_READONLY = [...GLOBAL_TABLES]

/**
 * RLS forced with NO policy and no grant to the request roles: the request role
 * sees and writes nothing; privileged pool only (asserted below). Every entry
 * says what it holds.
 */
const DENY_ALL_LEDGERS = new Set<string>([
  // Deployment-wide decisions taken once (migration 0231), e.g. the default
  // mailbox encryption: no org column, privileged pool only.
  "kernel.instance_settings",
  // What this instance sends to the Liaison team (migration 0244):
  // instance-wide, no org column, privileged pool only.
  "kernel.control_plane_outbox",
  // Outcomes of the signed Control→cell requests (migration 0247):
  // instance-wide, no org column, privileged pool only.
  "kernel.cloud_request_outcomes",
  // Restore drill markers (migration 0269): instance-wide, no org column,
  // privileged pool only.
  "kernel.restore_drill_markers",
  // Opt-out link tokens (migration 0313): org-scoped, but read and written
  // only by the send path and the public opt-out route, on the privileged pool.
  "kernel.suppression_links",
  // The data steps run when an in-tree app became a catalog app (migration
  // 0293): instance-wide, no org column, written and read by the boot
  // reconcile (modules/apps/moved-apps.ts) through the privileged pool only.
  "kernel.app_adoptions",
  // The adapter documents of the platform-held API connections (migration
  // 0300): read and written by connections/api/store.ts through the
  // privileged pool only, scoped to the org explicitly.
  "kernel.api_adapters",
  "kernel.api_adapter_versions",
  // The moves an org took part in, per instance (migration 0270): privileged
  // pool only, never read by a person.
  "kernel.org_transfer_ledger",
  "kernel.demo_leads",
  "kernel.durable_consumer_marks",
  // Demo visitors' model spend (migration 0180): instance-level, an email's
  // budget spans orgs, so no org column; read and written by demo-spend.ts
  // through the privileged pool only.
  "kernel.demo_spend",
  // Once-per-beat marks of the demo world injectors (migration 0182): org_id
  // for the cascade, but worker bookkeeping no person reads; claimed and read
  // by modules/demo/world through the privileged pool only.
  "kernel.demo_world_marks",
  // Every app version activation, switch-back and refusal (migration 0212):
  // instance-level, read and written by activation.ts through the privileged
  // pool only; org admins see their apps' states through the API.
  "kernel.app_activation_events",
  // Agent turns and their journal (migration 0225): hold tool results, written
  // and read only by modules/agent/runtime/turn-ledger.ts through the
  // privileged pool; no route reads them.
  "kernel.agent_turns",
  "kernel.agent_turn_events",
  // Outside effects claimed by key (migration 0226): effect results, written
  // and read only by lib/effect-once.ts through the privileged pool.
  "kernel.effect_ledger",
  // Verified webhook deliveries stored before their handler runs (migration
  // 0289): payloads and headers, written and read only by
  // modules/webhooks/inbox.ts through the privileged pool.
  "kernel.webhook_inbox",
  // An operator's org deletions and the legal-retention archives they wrote
  // (migration 0236): instance level, they outlive the org (no org_id, the org
  // is deleted_org_id); read and written by modules/org/delete through the
  // privileged pool only.
  "kernel.org_deletions",
  "kernel.legal_archives",
])

describe("RLS completeness on all org-scoped tables (dynamic)", () => {
  const orgA = "00000000-0000-0000-0000-00000000000a"
  const orgB = "00000000-0000-0000-0000-00000000000b"

  // Tables discovered dynamically in beforeAll.
  let orgScopedTables: string[] = []

  // Clean stale data from previous runs so tests start from a known state.
  beforeAll(async () => {
    const rows = await sql`
      SELECT n.nspname AS schema, c.relname AS tbl
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a
        ON a.attrelid = c.oid
       AND a.attname = 'org_id'
       AND a.attnum > 0
       AND NOT a.attisdropped
      WHERE c.relkind = 'r'
        AND (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%')
      ORDER BY n.nspname, c.relname
    `
    orgScopedTables = rows.map((r: any) => `${r.schema}.${r.tbl}`)

    await sql.unsafe(`DELETE FROM kernel.thread_participants WHERE org_id = '${orgA}'`)
    await sql.unsafe(`DELETE FROM kernel.threads WHERE org_id = '${orgA}'`)
    await sql.unsafe(`DELETE FROM kernel.timeline_entries WHERE org_id = '${orgA}'`)
    await sql.unsafe(`DELETE FROM kernel.users WHERE org_id = '${orgA}'`)
    await sql.unsafe(`DELETE FROM kernel.organizations WHERE id = '${orgA}'`)
  })

  afterAll(async () => {
    // Ensure cleanup even if individual tests fail
    await sql.unsafe(`DELETE FROM kernel.thread_participants WHERE org_id = '${orgA}'`)
    await sql.unsafe(`DELETE FROM kernel.threads WHERE org_id = '${orgA}'`)
    await sql.unsafe(`DELETE FROM kernel.timeline_entries WHERE org_id = '${orgA}'`)
    await sql.unsafe(`DELETE FROM kernel.users WHERE org_id = '${orgA}'`)
    await sql.unsafe(`DELETE FROM kernel.organizations WHERE id = '${orgA}'`)
  })

  /** The set the assertions run over: org-scoped, minus privileged-global, minus known gaps. */
  function governedTables(): string[] {
    return orgScopedTables.filter((t) => !PRIVILEGED_GLOBAL_TABLES.has(t) && !KNOWN_RLS_GAPS.has(t))
  }

  // ── Sanity: discovery actually found the schema ─────────────────────────

  it("discovers a non-trivial set of org-scoped tables", () => {
    // Guards against a silently-empty query (e.g. wrong schema name) masking
    // every assertion below. The schema has dozens of org-scoped tables.
    expect(orgScopedTables.length).toBeGreaterThan(20)
  })

  it("every allowlisted table still exists and is still org-scoped", () => {
    // If a table is dropped/renamed, its allowlist entry is dead — fail so the
    // entry is removed rather than silently masking a future same-named table.
    const known = new Set(orgScopedTables)
    const stale: string[] = []
    for (const t of [...PRIVILEGED_GLOBAL_TABLES, ...KNOWN_RLS_GAPS]) {
      if (!known.has(t)) stale.push(t)
    }
    expect(stale).toEqual([])
  })

  // ── 1. FORCE RLS enabled on all governed org-scoped tables ──────────────
  // FORCE RLS ensures policies apply even to the table owner, closing a
  // privilege-escalation vector where a superuser/owner bypasses policies.

  it("all governed org-scoped tables have FORCE RLS enabled", async () => {
    const rows = await sql`
      SELECT n.nspname AS schema, c.relname AS tbl, c.relforcerowsecurity AS force
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%')
    `
    const forceByTable = new Map<string, boolean>()
    for (const r of rows as any[]) forceByTable.set(`${r.schema}.${r.tbl}`, r.force === true)

    const missing = governedTables().filter((t) => forceByTable.get(t) !== true)
    expect(missing).toEqual([])
  })

  // ── 2. RLS enabled on all governed org-scoped tables ────────────────────

  it("all governed org-scoped tables have RLS enabled", async () => {
    const rows = await sql`
      SELECT n.nspname AS schema, c.relname AS tbl, c.relrowsecurity AS rls
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%')
    `
    const rlsByTable = new Map<string, boolean>()
    for (const r of rows as any[]) rlsByTable.set(`${r.schema}.${r.tbl}`, r.rls === true)

    const missing = governedTables().filter((t) => rlsByTable.get(t) !== true)
    expect(missing).toEqual([])
  })

  // ── 3. At least one RLS policy on every governed org-scoped table ────────

  it("all governed org-scoped tables have at least one RLS policy", async () => {
    const rows = await sql`
      SELECT n.nspname AS schema, c.relname AS tbl,
        (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS npol
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%')
    `
    const polByTable = new Map<string, number>()
    for (const r of rows as any[]) polByTable.set(`${r.schema}.${r.tbl}`, Number(r.npol))

    // A deny-all ledger keeps forced RLS (asserted above) with no policy at all.
    const missing = governedTables().filter(
      (t) => (polByTable.get(t) ?? 0) < 1 && !DENY_ALL_LEDGERS.has(t),
    )
    expect(missing).toEqual([])
  })

  it("a deny-all ledger has no policy and no privilege for the request roles", async () => {
    const rows = (await sql`
      SELECT t AS tbl, r AS role,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = to_regclass(t))::int AS npol,
             has_table_privilege(r, t, 'SELECT') OR has_table_privilege(r, t, 'INSERT') OR
             has_table_privilege(r, t, 'UPDATE') OR has_table_privilege(r, t, 'DELETE') OR
             has_table_privilege(r, t, 'TRUNCATE') OR has_table_privilege(r, t, 'TRIGGER') AS any_priv
      FROM unnest(${[...DENY_ALL_LEDGERS]}::text[]) AS t,
           unnest(ARRAY['liaison_rls', 'liaison_request']) AS r
      WHERE to_regclass(t) IS NOT NULL
        AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
    `) as any[]
    expect(rows.length).toBeGreaterThanOrEqual(DENY_ALL_LEDGERS.size)
    expect(rows.filter((r) => r.npol > 0 || r.any_priv).map((r) => `${r.tbl} ${r.role}`)).toEqual(
      [],
    )
  })

  // ── 4. No governed policy targets PUBLIC ────────────────────────────────
  // polroles = '{0}' means "applies to all roles" (TO PUBLIC).

  it("no governed table has a TO PUBLIC policy", async () => {
    const rows = await sql`
      SELECT n.nspname AS schema, c.relname AS tbl, pol.polname
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%')
        AND pol.polroles = '{0}'
    `
    const governed = new Set(governedTables())
    const publicPolicies = (rows as any[])
      .map((r) => ({ table: `${r.schema}.${r.tbl}`, pol: r.polname }))
      .filter((r) => governed.has(r.table))
    expect(publicPolicies).toEqual([])
  })

  // ── 5. INSERT and ALL policies have WITH CHECK on governed tables ────────

  it("INSERT and ALL policies have WITH CHECK clause", async () => {
    const rows = await sql`
      SELECT n.nspname AS schema, c.relname AS tbl, pol.polname,
        CASE pol.polcmd WHEN 'a' THEN 'INSERT' WHEN '*' THEN 'ALL' END AS command,
        pol.polwithcheck
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%')
        AND pol.polcmd IN ('a', '*')
    `
    const governed = new Set(governedTables())
    const missing: string[] = []
    for (const row of rows as any[]) {
      const table = `${row.schema}.${row.tbl}`
      if (!governed.has(table)) continue
      if (row.polwithcheck === null) {
        missing.push(`${table}: policy "${row.polname}" (${row.command}) has no WITH CHECK`)
      }
    }
    expect(missing).toEqual([])
  })

  // ── 5b. Tables WITHOUT org_id (security pass 3, S3b) ─────────────────────
  // A table with no org_id column is either user-scoped, global, or a ledger.
  // Each one has RLS enabled + forced + a policy, or is a reviewed global table
  // the request role can at most read.

  it("every kernel/app_* table without org_id is RLS-governed or a reviewed global table", async () => {
    const rows = (await sql`
      SELECT n.nspname AS schema, c.relname AS tbl, c.relrowsecurity AS rls,
             c.relforcerowsecurity AS force,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS npol
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%')
        AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                        AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped)
    `) as any[]
    const ungoverned = rows
      .filter((r) => !(r.rls && r.force && Number(r.npol) > 0))
      .filter((r) => !(r.rls && r.force && DENY_ALL_LEDGERS.has(`${r.schema}.${r.tbl}`)))
      .map((r) => `${r.schema}.${r.tbl}`)
      .filter((t) => !GLOBAL_TABLES.has(t))
    expect(ungoverned).toEqual([])
  })

  it("the request role cannot write a reviewed global table", async () => {
    const rows = (await sql`
      SELECT t AS tbl,
             has_table_privilege('liaison_rls', t, 'INSERT') OR
             has_table_privilege('liaison_rls', t, 'UPDATE') OR
             has_table_privilege('liaison_rls', t, 'DELETE') OR
             has_table_privilege('liaison_rls', t, 'TRUNCATE') AS writable
      FROM unnest(${GLOBAL_TABLES_READONLY}::text[]) AS t
      WHERE to_regclass(t) IS NOT NULL
    `) as any[]
    expect(rows.filter((r) => r.writable).map((r) => r.tbl)).toEqual([])
  })

  it("the request role holds no TRUNCATE or TRIGGER on an org-scoped table (both ignore RLS)", async () => {
    const rows = (await sql`
      SELECT n.nspname || '.' || c.relname AS tbl
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%')
        AND (has_table_privilege('liaison_rls', c.oid, 'TRUNCATE')
             OR has_table_privilege('liaison_rls', c.oid, 'TRIGGER'))
      ORDER BY 1
    `) as any[]
    const governed = new Set(governedTables())
    expect(rows.map((r) => r.tbl).filter((t: string) => governed.has(t))).toEqual([])
  })

  it("the definer role can run the search-ACL recompute on every shareable table", async () => {
    // kernel.recompute_search_acl (migration 0178) runs as liaison_definer; a
    // table recreated without these grants fails every sharing change with 42501.
    const rows = (await sql`
      SELECT t.resource_table::text AS tbl,
             has_schema_privilege('liaison_definer', c.relnamespace, 'USAGE') AS usage,
             has_table_privilege('liaison_definer', c.oid, 'SELECT') AS sel,
             has_column_privilege('liaison_definer', c.oid, 'acl_user_ids', 'UPDATE') AS users,
             has_column_privilege('liaison_definer', c.oid, 'acl_role_ids', 'UPDATE') AS roles
      FROM kernel.shareable_resource_types t JOIN pg_class c ON c.oid = t.resource_table
      ORDER BY 1
    `) as any[]
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const r of rows) {
      expect(r).toEqual({ tbl: r.tbl, usage: true, sel: true, users: true, roles: true })
    }
  })

  // ── 6. Cross-org isolation tests (retained from the frozen guard) ────────

  it("cross-org SELECT on users table is blocked under RLS", async () => {
    const userId = "00000000-0000-0000-0000-a00000000001"
    await sql.unsafe(`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES ('${orgA}', 'RLS Test Org A', 'rls-test-a')
      ON CONFLICT (id) DO NOTHING
    `)
    await sql.unsafe(`
      INSERT INTO kernel.users (id, org_id, email, password_hash, name)
      VALUES ('${userId}', '${orgA}', 'rls-users-test@a.com', 'hash', 'RLS User')
      ON CONFLICT (id) DO NOTHING
    `)

    const result = await withRlsContext(
      {
        actorType: "user",
        userId: "00000000-0000-0000-0000-000000000099",
        orgId: orgB,
        scopes: ["*"],
        dimensionGrants: {},
      },
      async (tx) => {
        return tx.execute(drizzleSql`SELECT id FROM kernel.users WHERE id = ${userId}::uuid`)
      },
    )
    expect(result).toHaveLength(0)

    await sql.unsafe(`DELETE FROM kernel.users WHERE id = '${userId}'`)
    await sql.unsafe(`DELETE FROM kernel.organizations WHERE id = '${orgA}'`)
  })

  it("cross-org SELECT on timeline_entries is blocked under RLS", async () => {
    const entryId = "00000000-0000-0000-0000-a00000000002"
    await sql.unsafe(`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES ('${orgA}', 'RLS Test Org A', 'rls-test-a')
      ON CONFLICT (id) DO NOTHING
    `)
    await sql.unsafe(`
      INSERT INTO kernel.timeline_entries (id, org_id, app, entity_type, entity_id, action, actor_id, actor_type, summary)
      VALUES ('${entryId}', '${orgA}', 'kernel', 'test', 'e1', 'create', '00000000-0000-0000-0000-a00000000001', 'user', 'test entry')
      ON CONFLICT (id) DO NOTHING
    `)

    const result = await withRlsContext(
      {
        actorType: "user",
        userId: "00000000-0000-0000-0000-000000000099",
        orgId: orgB,
        scopes: ["*"],
        dimensionGrants: {},
      },
      async (tx) => {
        return tx.execute(
          drizzleSql`SELECT id FROM kernel.timeline_entries WHERE id = ${entryId}::uuid`,
        )
      },
    )
    expect(result).toHaveLength(0)

    await sql.unsafe(`DELETE FROM kernel.timeline_entries WHERE id = '${entryId}'`)
    await sql.unsafe(`DELETE FROM kernel.organizations WHERE id = '${orgA}'`)
  })

  it("retargeted thread policies still work under liaison_rls", async () => {
    const threadId = "00000000-0000-0000-0000-a00000000003"
    const userId = "00000000-0000-0000-0000-a00000000004"
    await sql.unsafe(`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES ('${orgA}', 'RLS Test Org A', 'rls-test-a')
      ON CONFLICT (id) DO NOTHING
    `)
    await sql.unsafe(`
      INSERT INTO kernel.users (id, org_id, email, password_hash, name)
      VALUES ('${userId}', '${orgA}', 'rls-thread-test@a.com', 'hash', 'Thread User')
      ON CONFLICT (id) DO NOTHING
    `)
    await sql.unsafe(`
      INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES ('${threadId}', '${orgA}', 'rls-test-thread', '${userId}')
      ON CONFLICT (id) DO NOTHING
    `)
    await sql.unsafe(`
      INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES ('${threadId}', '${userId}', '${orgA}', 'member')
      ON CONFLICT DO NOTHING
    `)

    const result = await withRlsContext(
      { actorType: "user", userId, orgId: orgA, scopes: ["*"], dimensionGrants: {} },
      async (tx) => {
        return tx.execute(drizzleSql`SELECT id FROM kernel.threads WHERE id = ${threadId}::uuid`)
      },
    )
    expect(result).toHaveLength(1)

    const crossOrg = await withRlsContext(
      { actorType: "user", userId, orgId: orgB, scopes: ["*"], dimensionGrants: {} },
      async (tx) => {
        return tx.execute(drizzleSql`SELECT id FROM kernel.threads WHERE id = ${threadId}::uuid`)
      },
    )
    expect(crossOrg).toHaveLength(0)

    await sql.unsafe(`DELETE FROM kernel.thread_participants WHERE thread_id = '${threadId}'`)
    await sql.unsafe(`DELETE FROM kernel.threads WHERE id = '${threadId}'`)
    await sql.unsafe(`DELETE FROM kernel.users WHERE id = '${userId}'`)
    await sql.unsafe(`DELETE FROM kernel.organizations WHERE id = '${orgA}'`)
  })
})
