// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The external-user migrations on a database that already holds people, run by
// a migration login that is NOT a superuser: it owns the tables and is a member
// of the runtime roles, as such a login is, and has neither superuser nor
// BYPASSRLS, so FORCE ROW LEVEL SECURITY applies to it.
//
// What that login cannot do is what these tests are for. A role that holds
// nothing can read nothing under FORCE RLS, so a definer function it owned would
// read every row as missing, and ALTER ... OWNER TO needs the new owner to hold
// CREATE on the schema.
//
// It owns a scratch DATABASE: the migration SQL names `kernel` literally. The
// migrations before these run as the superuser, with the real migrator over a
// journal cut at the last one; everything below is on that scratch database and
// goes with it. Roles are cluster wide: an older migration, replayed on the way,
// takes back any extra membership of the request login, so that one is given
// back in the same breath.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import postgres from "postgres"
import { runMigrations } from "~/db/migrate"
import { insertSql } from "~/seed/factories/org/test-rows"

const MIGRATIONS = join(import.meta.dir, "migrations")
const FIRST_NEW_TAG = "0275_mail_inbound_sender_index"
const LAST_NEW_TAG = "0281_portal_role_and_schema"

function superuserUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const suffix = randomBytes(5).toString("hex")
const dbName = `liaison_mig_external_${suffix}`
const login = `liaison_mig_login_${suffix}`
const password = randomBytes(12).toString("hex")

const adminUrl = new URL(superuserUrl())
const freshAsSuperuser = new URL(adminUrl)
freshAsSuperuser.pathname = `/${dbName}`
const freshAsLogin = new URL(freshAsSuperuser)
freshAsLogin.username = login
freshAsLogin.password = password

const ORG_ID = crypto.randomUUID()
const ACTIVE_A = crypto.randomUUID()
const ACTIVE_B = crypto.randomUUID()
const DEACTIVATED = crypto.randomUUID()
const EXTERNAL = crypto.randomUUID()
const COMPANY = crypto.randomUUID()
const ROLE_ID = crypto.randomUUID()

interface JournalEntry {
  tag: string
}

/** A copy of the migrations folder whose journal ends at `index + offset`. */
function folderUpTo(tag: string, offset: number): string {
  const dir = mkdtempSync(join(tmpdir(), "mig-external-"))
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
let seatsBefore = 0

const seatQuery = (db: postgres.Sql) =>
  db<{ n: number }[]>`SELECT count(*)::int AS n FROM kernel.users
                       WHERE org_id = ${ORG_ID} AND status = 'active'`

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} })
  await admin.unsafe(`CREATE DATABASE "${dbName}"`)
  const before = folderUpTo(FIRST_NEW_TAG, -1)
  folders.push(before)
  await runMigrations(freshAsSuperuser.toString(), { migrationsFolder: before })
  // The replay took this back, cluster wide. Everything else on this cluster needs it now.
  await admin.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_portal') THEN
      CREATE ROLE liaison_portal NOLOGIN NOBYPASSRLS;
    END IF;
  END $$`)
  await admin.unsafe(`GRANT liaison_portal TO liaison_request`)

  fresh = postgres(freshAsSuperuser.toString(), { max: 1, onnotice: () => {} })
  // People who are already there when the migrations run.
  await fresh.unsafe(
    insertSql("kernel.organizations", { id: ORG_ID, name: "Existing", slug: "existing" }),
  )
  await fresh.unsafe(
    insertSql("kernel.users", [
      { id: ACTIVE_A, org_id: ORG_ID, email: "a@example.com", name: "A", status: "active" },
      { id: ACTIVE_B, org_id: ORG_ID, email: "b@example.com", name: "B", status: "active" },
      { id: DEACTIVATED, org_id: ORG_ID, email: "c@example.com", name: "C", status: "deactivated" },
    ]),
  )
  seatsBefore = (await seatQuery(fresh))[0]?.n ?? -1
  // A database whose calendar app registered before the column was declared.
  await fresh.unsafe(`CREATE SCHEMA app_calendar`)
  await fresh.unsafe(`CREATE TABLE app_calendar.events (id uuid PRIMARY KEY)`)

  // The login, as it would stand had it run those migrations itself.
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
                WHERE nspname = 'kernel' OR nspname = 'drizzle' OR nspname LIKE 'app\\_%' LOOP
        EXECUTE format('ALTER SCHEMA %I OWNER TO "${login}"', r.nspname);
      END LOOP;
      FOR r IN SELECT n.nspname, c.relname FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r', 'p')
                  AND (n.nspname = 'kernel' OR n.nspname = 'drizzle' OR n.nspname LIKE 'app\\_%') LOOP
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

describe("the external-user migrations on a live database, by a non-superuser login", () => {
  test("the new migrations apply on a fresh database as a non-superuser migration login", async () => {
    const [who] = await asLogin<{ super: boolean; bypass: boolean }[]>`
      SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(who).toEqual({ super: false, bypass: false })

    const all = folderUpTo(LAST_NEW_TAG, 0)
    folders.push(all)
    await runMigrations(freshAsLogin.toString(), { migrationsFolder: all })

    const owners = await fresh<{ name: string; owner: string }[]>`
      SELECT p.oid::regprocedure::text AS name, p.proowner::regrole::text AS owner
        FROM pg_proc p
       WHERE p.oid IN ('portal.company_id()'::regprocedure, 'kernel.user_roles_member_only()'::regprocedure)
       ORDER BY 1`
    expect(owners.map((o) => o.owner)).toEqual(["liaison_definer", "liaison_definer"])
    const [view] = await fresh<{ owner: string }[]>`
      SELECT relowner::regrole::text AS owner FROM pg_class WHERE oid = 'portal.me'::regclass`
    expect(view?.owner).toBe("liaison_admin")
    const [rights] = await fresh<
      { portal_definer: boolean; kernel_definer: boolean; portal_admin: boolean }[]
    >`
      SELECT has_schema_privilege('liaison_definer', 'portal', 'CREATE') AS portal_definer,
             has_schema_privilege('liaison_definer', 'kernel', 'CREATE') AS kernel_definer,
             has_schema_privilege('liaison_admin', 'portal', 'CREATE') AS portal_admin`
    // Handed over and taken back; only the owner of the views keeps it, for the next view.
    expect(rights).toEqual({ portal_definer: false, kernel_definer: false, portal_admin: true })
  }, 60_000)

  test("existing users stay member, seat count unchanged", async () => {
    const rows = await fresh<{ id: string; user_type: string; company_id: string | null }[]>`
      SELECT id, user_type, company_id FROM kernel.users WHERE org_id = ${ORG_ID}`
    expect(rows.length).toBe(3)
    for (const row of rows) {
      expect(row.user_type).toBe("member")
      expect(row.company_id).toBeNull()
    }
    expect((await seatQuery(fresh))[0]?.n).toBe(seatsBefore)
    expect(seatsBefore).toBe(2)
  })

  test("an existing database has app_calendar.events.event_type after the migrations", async () => {
    const rows = await fresh<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'app_calendar' AND table_name = 'events' AND column_name = 'event_type'`
    expect([...rows]).toEqual([{ data_type: "text", is_nullable: "YES" }])
  })

  test("portal.company_id returns the caller's company under FORCE RLS on that login", async () => {
    await fresh.unsafe(
      insertSql("kernel.users", {
        id: EXTERNAL,
        org_id: ORG_ID,
        email: "client@example.com",
        name: "Client",
        user_type: "external",
        company_id: COMPANY,
      }),
    )
    // The premise: the login itself reads nothing here, so a definer it owned would too.
    const [plain] = await asLogin<{ n: number }[]>`SELECT count(*)::int AS n FROM kernel.users`
    expect(plain?.n).toBe(0)

    const row = await asLogin.begin(async (tx) => {
      await tx`SELECT set_config('app.current_user_id', ${EXTERNAL}, true)`
      await tx`SELECT set_config('role', 'liaison_portal', true)`
      const [read] = await tx<{ company: string; me: number }[]>`
        SELECT portal.company_id() AS company, (SELECT count(*)::int FROM portal.me) AS me`
      return read
    })
    expect(row).toEqual({ company: COMPANY, me: 1 })
  })

  test("a role for an external user raises as liaison_rls on that login", async () => {
    await fresh.unsafe(insertSql("kernel.roles", { id: ROLE_ID, org_id: ORG_ID, name: "plain" }))
    await expect(
      asLogin.begin(async (tx) => {
        await tx`SELECT set_config('app.current_org_id', ${ORG_ID}, true)`
        await tx`SELECT set_config('app.current_user_id', ${ACTIVE_A}, true)`
        await tx`SELECT set_config('role', 'liaison_rls', true)`
        await tx.unsafe(
          insertSql("kernel.user_roles", { user_id: EXTERNAL, role_id: ROLE_ID, org_id: ORG_ID }),
        )
      }),
    ).rejects.toThrow("an external user holds no role")
  })
})
