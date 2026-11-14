// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The time and budgets and reconcile migrations on a database that already
// holds projects and tasks, run by a migration login that is NOT a superuser
// (no BYPASSRLS), as migration-p1.test.ts does for the migrations before them.
// Every project reads off, every task keeps its answer, the new tables start
// empty, and a pipeline can never hold the switch.
//
// It owns a scratch DATABASE. The migrations before these run as the superuser
// over a journal cut at the last one; roles are cluster wide, so the request
// login's portal membership an older migration takes back is given back.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postgres from "postgres"
import { runMigrations } from "~/db/migrate"
import { insertSql } from "~/seed/factories/org/test-rows"
import { withRoleCatalogLock } from "~/tests/helpers/role-catalog-lock"

const MIGRATIONS = join(import.meta.dir, "migrations")
const FIRST_NEW_TAG = "0321_projects_time_plan"
const LAST_NEW_TAG = "0322_projects_reconcile"

const NEW_TABLES = [
  "billing_claims",
  "cost_rates",
  "days_off",
  "person_capacity",
  "project_billing_terms",
  "project_time_plan",
  "project_timeboxes",
  "reconciliation_lines",
  "reconciliation_proofs",
  "reconciliations",
  "task_time",
  "time_settings",
]
const NEW_PROJECT_COLUMNS = [
  "time_budgets_on",
  "time_budgets_changed_by",
  "time_budgets_changed_at",
]
const NEW_TASK_COLUMNS = ["timebox_minutes", "is_milestone"]

function superuserUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const suffix = randomBytes(5).toString("hex")
const dbName = `liaison_mig_time_${suffix}`
const login = `liaison_mig_time_login_${suffix}`
const password = randomBytes(12).toString("hex")

const adminUrl = new URL(superuserUrl())
const freshAsSuperuser = new URL(adminUrl)
freshAsSuperuser.pathname = `/${dbName}`
const freshAsLogin = new URL(freshAsSuperuser)
freshAsLogin.username = login
freshAsLogin.password = password

const ORG_ID = crypto.randomUUID()
const ANNA = crypto.randomUUID()
const THREAD = crypto.randomUUID()
const WORK = crypto.randomUUID()
const PIPELINE = crypto.randomUUID()
const AT = "2026-03-02T09:00:00.000Z"

interface JournalEntry {
  tag: string
}

/** A copy of the migrations folder whose journal ends at `index + offset`. */
function folderUpTo(tag: string, offset: number): string {
  const dir = mkdtempSync(join(tmpdir(), "mig-time-"))
  cpSync(MIGRATIONS, dir, { recursive: true })
  const path = join(dir, "meta", "_journal.json")
  const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: JournalEntry[] }
  const at = journal.entries.findIndex((e) => e.tag === tag)
  if (at < 0) throw new Error(`${tag} is not in the journal`)
  journal.entries = journal.entries.slice(0, at + offset + 1)
  writeFileSync(path, JSON.stringify(journal, null, 2))
  return dir
}

let admin: postgres.Sql
let fresh: postgres.Sql
let asLogin: postgres.Sql
const folders: string[] = []
let projectsBefore: Record<string, unknown>[] = []
let tasksBefore: Record<string, unknown>[] = []

const projectRows = (db: postgres.Sql) =>
  db<{ row: Record<string, unknown> }[]>`
    SELECT to_jsonb(p) - ${NEW_PROJECT_COLUMNS}::text[] AS row
      FROM app_projects.projects p WHERE org_id = ${ORG_ID} ORDER BY id`
const taskRows = (db: postgres.Sql) =>
  db<{ row: Record<string, unknown> }[]>`
    SELECT to_jsonb(t) - ${NEW_TASK_COLUMNS}::text[] AS row
      FROM app_projects.tasks t WHERE org_id = ${ORG_ID} ORDER BY id`

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} })
  await admin.unsafe(`CREATE DATABASE "${dbName}"`)
  const before = folderUpTo(FIRST_NEW_TAG, -1)
  folders.push(before)
  await withRoleCatalogLock(adminUrl, async () => {
    await runMigrations(freshAsSuperuser.toString(), { migrationsFolder: before })
    // The replay took this back, cluster wide. Everything else on this cluster needs it now.
    await admin.unsafe(`GRANT liaison_portal TO liaison_request`)
  })

  fresh = postgres(freshAsSuperuser.toString(), { max: 1, onnotice: () => {} })
  // What is already there when the migrations run: an org with a work project
  // and a pipeline, and tasks on both.
  await fresh.unsafe(
    insertSql("kernel.organizations", { id: ORG_ID, name: "Existing", slug: "existing" }),
  )
  await fresh.unsafe(
    insertSql("kernel.users", {
      id: ANNA,
      org_id: ORG_ID,
      email: "anna@example.com",
      name: "Anna",
      status: "active",
    }),
  )
  await fresh.unsafe(
    insertSql("kernel.threads", {
      id: THREAD,
      org_id: ORG_ID,
      handle: "existing-thread",
      created_by: ANNA,
      created_at: AT,
      updated_at: AT,
    }),
  )
  for (const [id, key, kind] of [
    [WORK, "WRK", "work"],
    [PIPELINE, "PIP", "pipeline"],
  ] as const) {
    await fresh.unsafe(
      insertSql("app_projects.projects", {
        id,
        org_id: ORG_ID,
        name: `Board ${key}`,
        key,
        kind,
        owner_id: ANNA,
        created_at: AT,
        updated_at: AT,
      }),
    )
    const status = crypto.randomUUID()
    await fresh.unsafe(
      insertSql("app_projects.project_statuses", {
        id: status,
        org_id: ORG_ID,
        project_id: id,
        label: "To do",
        '"order"': 1,
        terminal: false,
        created_at: AT,
        updated_at: AT,
      }),
    )
    await fresh.unsafe(
      insertSql(
        "app_projects.tasks",
        Array.from({ length: 12 }, (_, i) => ({
          org_id: ORG_ID,
          project_id: id,
          status_id: status,
          title: `${key} task ${i + 1}`,
          number: i + 1,
          thread_id: THREAD,
          created_by: ANNA,
          assignee_id: i % 3 === 0 ? ANNA : null,
          due_date: i % 2 === 0 ? "2026-04-01" : null,
          created_at: AT,
          updated_at: AT,
        })),
      ),
    )
  }
  projectsBefore = (await projectRows(fresh)).map((r) => r.row)
  tasksBefore = (await taskRows(fresh)).map((r) => r.row)

  // The login, as it would stand had it run the earlier migrations itself: it
  // owns kernel; the app schemas stay liaison_admin's, a role it is a member of.
  await admin.unsafe(
    `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`,
  )
  await admin.unsafe(
    `GRANT liaison_admin, liaison_rls, liaison_schema_admin, liaison_definer TO "${login}"`,
  )
  await admin.unsafe(`GRANT liaison_portal TO "${login}" WITH ADMIN OPTION`)
  await admin.unsafe(`ALTER DATABASE "${dbName}" OWNER TO "${login}"`)
  await fresh.unsafe(`DO $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT nspname FROM pg_namespace
                WHERE nspname = 'kernel' OR nspname = 'drizzle' LOOP
        EXECUTE format('ALTER SCHEMA %I OWNER TO "${login}"', r.nspname);
      END LOOP;
      FOR r IN SELECT n.nspname, c.relname FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p')
                  AND (n.nspname = 'kernel' OR n.nspname = 'drizzle') LOOP
        EXECUTE format('ALTER TABLE %I.%I OWNER TO "${login}"', r.nspname, r.relname);
      END LOOP;
    END $$`)
  asLogin = postgres(freshAsLogin.toString(), { max: 1, onnotice: () => {} })
}, 240_000)

afterAll(async () => {
  await asLogin?.end()
  await fresh?.end()
  if (admin) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    const held = await admin<{ role: string; member: string; grantor: string }[]>`
      SELECT r.rolname AS role, u.rolname AS member, g.rolname AS grantor
        FROM pg_auth_members a
        JOIN pg_roles r ON r.oid = a.roleid
        JOIN pg_roles u ON u.oid = a.member
        JOIN pg_roles g ON g.oid = a.grantor
       WHERE u.rolname = ${login} OR g.rolname = ${login}`
    for (const m of held) {
      await admin.unsafe(`REVOKE "${m.role}" FROM "${m.member}" GRANTED BY "${m.grantor}" CASCADE`)
    }
    await admin.unsafe(`DROP ROLE IF EXISTS "${login}"`)
    await admin.end()
  }
  for (const dir of folders) rmSync(dir, { recursive: true, force: true })
})

describe("the time and budgets migrations on a live database", () => {
  test("an org with projects and tasks migrates with every project off and the same API answers", async () => {
    const [who] = await asLogin<{ super: boolean; bypass: boolean }[]>`
      SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(who).toEqual({ super: false, bypass: false })

    const all = folderUpTo(LAST_NEW_TAG, 0)
    folders.push(all)
    await withRoleCatalogLock(adminUrl, () =>
      runMigrations(freshAsLogin.toString(), { migrationsFolder: all }),
    )

    // Every project is off, nobody turned anything, and no task has a timebox.
    const projects = await fresh<
      { kind: string; on: boolean; by: string | null; at: Date | null }[]
    >`
      SELECT kind, time_budgets_on AS on, time_budgets_changed_by AS by, time_budgets_changed_at AS at
        FROM app_projects.projects WHERE org_id = ${ORG_ID} ORDER BY kind`
    expect([...projects]).toEqual([
      { kind: "pipeline", on: false, by: null, at: null },
      { kind: "work", on: false, by: null, at: null },
    ])
    const [tasks] = await fresh<{ n: number; timeboxed: number; milestones: number }[]>`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE timebox_minutes IS NOT NULL)::int AS timeboxed,
             count(*) FILTER (WHERE is_milestone)::int AS milestones
        FROM app_projects.tasks WHERE org_id = ${ORG_ID}`
    expect(tasks).toEqual({ n: 24, timeboxed: 0, milestones: 0 })

    // Every column a project or a task answered with before reads the same.
    expect((await projectRows(fresh)).map((r) => r.row)).toEqual(projectsBefore)
    expect((await taskRows(fresh)).map((r) => r.row)).toEqual(tasksBefore)

    // The new tables exist, start empty, and have RLS enabled and forced.
    const tables = await fresh<{ name: string; rls: boolean; forced: boolean; rows: number }[]>`
      SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (xpath('/row/n/text()',
               query_to_xml(format('SELECT count(*) AS n FROM app_projects.%I', c.relname), false, true, '')))[1]::text::int AS rows
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app_projects' AND c.relname = ANY(${NEW_TABLES}::text[])
       ORDER BY c.relname`
    expect([...tables]).toEqual(
      NEW_TABLES.map((name) => ({ name, rls: true, forced: true, rows: 0 })),
    )

    // The definer functions were handed over, and the schema right taken back.
    const owners = await fresh<{ owner: string }[]>`
      SELECT p.proowner::regrole::text AS owner FROM pg_proc p
       WHERE p.oid IN ('app_projects.task_time_totals(uuid, date, date)'::regprocedure,
                       'app_projects.project_time_cost(uuid, date, date)'::regprocedure)`
    expect(owners.map((o) => o.owner)).toEqual(["liaison_definer", "liaison_definer"])
    const [rights] = await fresh<{ projects: boolean }[]>`
      SELECT has_schema_privilege('liaison_definer', 'app_projects', 'CREATE') AS projects`
    expect(rights).toEqual({ projects: false })
  }, 120_000)

  test("a pipeline project cannot hold the switch", async () => {
    await expect(
      fresh`UPDATE app_projects.projects SET time_budgets_on = true WHERE id = ${PIPELINE}`,
    ).rejects.toThrow("projects_time_budgets_work_only")
    await fresh`UPDATE app_projects.projects SET time_budgets_on = true WHERE id = ${WORK}`
    // A pipeline holding nothing stays as it is; a work project with the switch
    // on cannot become a pipeline without turning it off first.
    await expect(
      fresh`UPDATE app_projects.projects SET kind = 'pipeline' WHERE id = ${WORK}`,
    ).rejects.toThrow("projects_time_budgets_work_only")
    await fresh`UPDATE app_projects.projects SET time_budgets_on = false WHERE id = ${WORK}`
  })

  test("a task timebox must be above zero", async () => {
    await expect(
      fresh`UPDATE app_projects.tasks SET timebox_minutes = 0 WHERE project_id = ${WORK}`,
    ).rejects.toThrow("tasks_timebox_minutes_positive")
  })
})
