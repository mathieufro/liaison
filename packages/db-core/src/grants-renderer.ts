// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Renders the `liaison_readonly` role's ALLOW-LIST grant SQL from a
// `ReadCatalog` — the single source of truth both `deploy/postgres-init/
// 20-readonly-role.sh` (fresh clusters) and `scripts/db-readonly-role.ts`
// (existing clusters) execute, eliminating the shell/TS sync problem (Task 7
// §7.1). Grant model is ALLOW-LIST, never `GRANT SELECT ON ALL TABLES`, and
// (S1 fail-closed fix) NEVER a bare full-row `GRANT SELECT ON <table>`
// either: every granted table gets a column-scoped
// `GRANT SELECT (<cols>) ON <table>` naming exactly the columns some read's
// `grantColumns` declares for it (SELECT projection + JOIN keys + WHERE +
// ORDER BY — `catalog.ts#resolveGrantColumns` enforces every table has this
// entry and that it never names a SECRET_COLUMNS column). This makes safety
// independent of SECRET_COLUMNS being exhaustive: an undeclared column
// (secret or not, present or added by a future migration) is unreadable by
// construction (42501) because it was simply never granted.
//
// A newly migrated table is INVISIBLE to `liaison_readonly` until it's added
// to the catalog and this file is regenerated — fail-closed by design, not a
// gap (Task 7 edge-case: "table stays inaccessible until explicitly added").

import type { ResolvedReadCatalog } from "./catalog"
import { secretColumnsForTable } from "./secret-columns"

const ROLE_NAME = "liaison_readonly"

// Roles that legitimately EXECUTE in-schema functions and must be explicitly re-granted
// after the function-EXECUTE revoke from PUBLIC below (revoking PUBLIC also strips these
// roles' implicit access; kernel's RLS policies depend on SECURITY DEFINER helpers).
// Must cover EVERY non-readonly liaison system role that may execute an in-schema
// function — including the privileged (BYPASSRLS) and DDL roles: application code calls
// kernel/app_* helper predicates as liaison_admin in privileged contexts, and
// liaison_schema_admin owns migrations. Omitting one would break the LIVE app's RLS
// predicate functions the moment PUBLIC EXECUTE is revoked. Only liaison_readonly is
// deliberately left WITHOUT execute (verified against a live FORCE-RLS instance).
// liaison_definer owns SECURITY DEFINER helpers that run as it and call other
// in-schema functions (a company's sharing rule calls kernel.has_scope).
const EXECUTION_ROLES = [
  "liaison_app",
  "liaison_rls",
  "liaison_admin",
  "liaison_schema_admin",
  "liaison_definer",
] as const

interface TableColumns {
  schema: string
  table: string
  columns: Set<string>
}

function collectTableColumns(catalog: ResolvedReadCatalog): Map<string, TableColumns> {
  const byTable = new Map<string, TableColumns>()
  for (const read of Object.values(catalog.reads)) {
    for (const tableRef of read.tables) {
      const [schema, table] = tableRef.split(".")
      if (!schema || !table) continue
      const key = tableRef
      const existing = byTable.get(key)
      const cols = existing?.columns ?? new Set<string>()
      // `grantColumns` is populated by `validateCatalog`/`resolveGrantColumns`
      // for every table a read touches — this is the ONLY source the
      // renderer trusts for what to grant (never the flat `columns` result
      // projection, which is insufficient for multi-table/joined reads).
      const tableGrantCols = read.grantColumns[key] ?? []
      for (const col of tableGrantCols) cols.add(col)
      byTable.set(key, { schema, table, columns: cols })
    }
  }
  return byTable
}

export interface RenderedGrants {
  sql: string
  schemas: string[]
  tables: string[]
}

/** Renders the full allow-list grants.sql content for a catalog. Pure —
 *  no I/O, deterministic given the same catalog (so a diff against the
 *  checked-in file detects catalog drift, per Task 7's sync-check test). */
export function renderReadonlyGrants(catalog: ResolvedReadCatalog): RenderedGrants {
  const byTable = collectTableColumns(catalog)
  const schemas = [...new Set([...byTable.values()].map((t) => t.schema))].sort()
  const tableKeys = [...byTable.keys()].sort()

  const lines: string[] = []
  lines.push("-- SPDX-License-Identifier: FSL-1.1-ALv2")
  lines.push("-- GENERATED FILE — do not hand-edit.")
  lines.push(
    `-- Rendered by packages/db-core/src/grants-renderer.ts from adapter "${catalog.adapter}".`,
  )
  lines.push(
    "-- Regenerate with `bun run scripts/db-readonly-role.ts --regenerate` after any catalog",
  )
  lines.push("-- change; verify with `bun run scripts/db-readonly-role.ts --check-sync`.")
  lines.push("")
  lines.push(`DO $$ BEGIN`)
  lines.push(`  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE_NAME}') THEN`)
  lines.push(
    `    CREATE ROLE ${ROLE_NAME} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS CONNECTION LIMIT 4;`,
  )
  lines.push(`  END IF;`)
  lines.push(`END $$;`)
  lines.push("")
  // BYPASSRLS is REQUIRED, not incidental: every governed table runs FORCE ROW LEVEL
  // SECURITY, whose policies key off the app's per-request session GUCs (app.org_id,
  // app.current_user_id, ...). This role is a standalone connection with no app request
  // context, so WITHOUT bypass every policy default-denies and the connector reads ZERO
  // rows (verified against a live RLS instance). Bypassing ROW policies is safe here
  // because the other walls are independent of RLS and still fully apply: column/table
  // GRANTs (secret columns never granted), default_transaction_read_only + no write grants
  // (no mutation), and per-read `WHERE org_id = :orgId` scoping in the catalog SQL. This is
  // the same posture liaison_admin uses for privileged cross-org reads. ALTER (not just
  // CREATE) so re-provisioning an existing NOBYPASSRLS role is corrected idempotently.
  lines.push(`ALTER ROLE ${ROLE_NAME} BYPASSRLS;`)
  lines.push(`ALTER ROLE ${ROLE_NAME} SET default_transaction_read_only = on;`)
  lines.push(`ALTER ROLE ${ROLE_NAME} SET statement_timeout = '15s';`)
  lines.push("")

  for (const schema of schemas) {
    lines.push(`GRANT USAGE ON SCHEMA ${schema} TO ${ROLE_NAME};`)
  }
  lines.push("")

  for (const key of tableKeys) {
    const t = byTable.get(key)
    if (!t) continue
    const secretCols = new Set(secretColumnsForTable(key).map((c) => c.toLowerCase()))
    const grantableCols = [...t.columns].filter((c) => !secretCols.has(c.toLowerCase())).sort()
    // Fail-closed invariant (S1): EVERY granted table gets a column-scoped
    // grant naming only the columns some read's `grantColumns` declared for
    // it — never a bare full-row `GRANT SELECT ON <table>`. `validateCatalog`
    // already guarantees every table has a non-empty `grantColumns` entry
    // and that none of its columns are SECRET_COLUMNS, so `grantableCols`
    // being empty here would mean that invariant was bypassed — treat it as
    // a programmer error, not a silent full-row fallback.
    if (grantableCols.length === 0) {
      throw new Error(
        `renderReadonlyGrants: table "${key}" has zero grantable columns — refusing to render ` +
          `a bare full-row GRANT (fail-closed). Check catalog "${catalog.adapter}"'s grantColumns for "${key}".`,
      )
    }
    lines.push(`GRANT SELECT (${grantableCols.join(", ")}) ON ${key} TO ${ROLE_NAME};`)
  }
  lines.push("")

  for (const schema of schemas) {
    lines.push(`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC;`)
    lines.push(`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${ROLE_NAME};`)
    lines.push(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`,
    )
    // Revoking PUBLIC strips the app execution roles' IMPLICIT EXECUTE too -- kernel's RLS
    // policies call SECURITY DEFINER helpers (e.g. kernel.is_thread_participant), so without
    // an explicit re-grant every RLS-scoped query in the schema starts failing with
    // "permission denied for function" (42501). Re-grant to the roles that legitimately
    // execute in-schema functions; liaison_readonly stays revoked (the whole point).
    for (const role of EXECUTION_ROLES) {
      lines.push(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role};`)
    }
    lines.push(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${EXECUTION_ROLES.join(", ")};`,
    )
  }
  lines.push("")

  return { sql: `${lines.join("\n")}\n`, schemas, tables: tableKeys }
}
