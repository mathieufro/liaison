// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The companies, suppressions, deals and lawful-basis migrations on a database
// that already holds contacts, roles and an external user's row shape, run by a
// migration login that is NOT a superuser (no BYPASSRLS, so FORCE ROW LEVEL
// SECURITY applies to it), as migration-external-user.test.ts does for the
// migrations before them.
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
const FIRST_NEW_TAG = "0314_companies"
const LAST_NEW_TAG = "0317_contact_company_and_lawful_basis"
/** Run after the others, on rows written since: a role, a direct grant and routines. */
const SCOPE_TAG = "0319_suppressions_read_for_conversation_readers"

function superuserUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const suffix = randomBytes(5).toString("hex")
const dbName = `liaison_mig_p1_${suffix}`
const login = `liaison_mig_p1_login_${suffix}`
const password = randomBytes(12).toString("hex")

const adminUrl = new URL(superuserUrl())
const freshAsSuperuser = new URL(adminUrl)
freshAsSuperuser.pathname = `/${dbName}`
const freshAsLogin = new URL(freshAsSuperuser)
freshAsLogin.username = login
freshAsLogin.password = password

const ORG_ID = crypto.randomUUID()
const ANNA = crypto.randomUUID()
const READERS = crypto.randomUUID()
const WRITERS = crypto.randomUUID()
const WILDCARD = crypto.randomUUID()
const MAILERS = crypto.randomUUID()
const MAIL_ADMINS = crypto.randomUUID()
const NOTHING = crypto.randomUUID()

interface JournalEntry {
  tag: string
}

/** A copy of the migrations folder whose journal ends at `index + offset`. */
function folderUpTo(tag: string, offset: number): string {
  const dir = mkdtempSync(join(tmpdir(), "mig-p1-"))
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
let versionBefore = -1

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
  // What is already there when the migrations run.
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
    insertSql(
      "kernel.contacts",
      Array.from({ length: 40 }, (_, i) => ({
        org_id: ORG_ID,
        handle: `c-${i}`,
        name: `Contact ${i}`,
        email: `c${i}@example.com`,
        company: i % 2 === 0 ? `Maison ${i}` : null,
      })),
    ),
  )
  const roles: [string, string, string[]][] = [
    [READERS, "readers", ["kernel:contacts:read", "mail:conversations:read"]],
    [WRITERS, "writers", ["kernel:contacts:read", "kernel:contacts:write"]],
    [WILDCARD, "wildcard", ["kernel:contacts:*", "mail:conversations:*"]],
    [MAILERS, "mailers", ["mail:conversations:write"]],
    [MAIL_ADMINS, "mail admins", ["mail:accounts:admin"]],
    [NOTHING, "nothing", ["tickets:tickets:read"]],
  ]
  for (const [id, name, scopes] of roles) {
    await fresh.unsafe(insertSql("kernel.roles", { id, org_id: ORG_ID, name }))
    for (const scope of scopes) {
      await fresh.unsafe(insertSql("kernel.role_scope_grants", { role_id: id, scope }))
    }
  }
  await fresh.unsafe(
    insertSql("kernel.user_roles", { user_id: ANNA, role_id: READERS, org_id: ORG_ID }),
  )
  await fresh.unsafe(
    insertSql("kernel.user_scope_grants", {
      user_id: ANNA,
      org_id: ORG_ID,
      scope: "kernel:contacts:write",
    }),
  )

  const [v] = await fresh<
    { v: number }[]
  >`SELECT permission_version AS v FROM kernel.users WHERE id = ${ANNA}`
  versionBefore = v?.v ?? -1

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

describe("the company, suppression, deal and lawful-basis migrations on a live database", () => {
  test("the new migrations apply on a fresh database as a non-superuser login", async () => {
    const [who] = await asLogin<{ super: boolean; bypass: boolean }[]>`
      SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(who).toEqual({ super: false, bypass: false })

    const all = folderUpTo(LAST_NEW_TAG, 0)
    folders.push(all)
    await withRoleCatalogLock(adminUrl, () =>
      runMigrations(freshAsLogin.toString(), { migrationsFolder: all }),
    )

    const owners = await fresh<{ name: string; owner: string }[]>`
      SELECT p.oid::regprocedure::text AS name, p.proowner::regrole::text AS owner
        FROM pg_proc p
       WHERE p.oid IN ('kernel.can_manage_company_sharing(uuid)'::regprocedure,
                       'app_projects.ensure_deal_value(uuid)'::regprocedure)
       ORDER BY 1`
    expect(owners.map((o) => o.owner)).toEqual(["liaison_definer", "liaison_definer"])
    const [rights] = await fresh<{ kernel: boolean; projects: boolean }[]>`
      SELECT has_schema_privilege('liaison_definer', 'kernel', 'CREATE') AS kernel,
             has_schema_privilege('liaison_definer', 'app_projects', 'CREATE') AS projects`
    // Handed over for the functions and taken back.
    expect(rights).toEqual({ kernel: false, projects: false })
  }, 60_000)

  test("after the migration every contact has no company and keeps its company text", async () => {
    const rows = await fresh<
      { handle: string; company: string | null; company_id: string | null }[]
    >`
      SELECT handle, company, company_id FROM kernel.contacts WHERE org_id = ${ORG_ID}`
    expect(rows.length).toBe(40)
    for (const row of rows) {
      const i = Number(row.handle.slice(2))
      expect(row.company_id).toBeNull()
      expect(row.company).toBe(i % 2 === 0 ? `Maison ${i}` : null)
    }
  })

  test("no lawful basis, consumer status or data source is claimed for an existing contact", async () => {
    const [counts] = await fresh<{ claimed: number }[]>`
      SELECT count(*)::int AS claimed FROM kernel.contacts
       WHERE org_id = ${ORG_ID}
         AND (lawful_basis IS NOT NULL OR lawful_basis_source IS NOT NULL OR lawful_basis_at IS NOT NULL
              OR is_consumer IS NOT NULL OR recipient_country IS NOT NULL OR data_source IS NOT NULL
              OR art14_notice_at IS NOT NULL)`
    expect(counts?.claimed).toBe(0)
    // And no default writes a claim on the next contact either.
    const defaults = await fresh<
      { column_name: string; column_default: string | null; is_nullable: string }[]
    >`
      SELECT column_name, column_default, is_nullable FROM information_schema.columns
       WHERE table_schema = 'kernel' AND table_name = 'contacts'
         AND column_name IN ('lawful_basis', 'lawful_basis_source', 'lawful_basis_at', 'is_consumer',
                             'recipient_country', 'data_source', 'art14_notice_at')
       ORDER BY column_name`
    expect(defaults.length).toBe(7)
    for (const column of defaults) {
      expect({ ...column, column_default: column.column_default ?? null }).toEqual({
        column_name: column.column_name,
        column_default: null,
        is_nullable: "YES",
      })
    }
  })

  test("whoever read or wrote contacts reads or writes companies, and mail roles get suppressions", async () => {
    const rows = await fresh<{ role_id: string; scope: string }[]>`
      SELECT role_id, scope FROM kernel.role_scope_grants
       WHERE role_id IN (${READERS}, ${WRITERS}, ${WILDCARD}, ${MAILERS}, ${MAIL_ADMINS}, ${NOTHING})
         AND (scope LIKE 'kernel:companies:%' OR scope LIKE 'mail:suppressions:%')`
    const by = (role: string) =>
      rows
        .filter((r) => r.role_id === role)
        .map((r) => r.scope)
        .sort()
    expect(by(READERS)).toEqual(["kernel:companies:read", "mail:suppressions:read"])
    expect(by(WRITERS)).toEqual(["kernel:companies:read", "kernel:companies:write"])
    expect(by(WILDCARD)).toEqual(["kernel:companies:*", "mail:suppressions:read"])
    // Writing mail already records an opt-out; removing one is for mail admins.
    expect(by(MAILERS)).toEqual([])
    expect(by(MAIL_ADMINS)).toEqual(["mail:suppressions:write"])
    expect(by(NOTHING)).toEqual([])
    const direct = await fresh<{ scope: string }[]>`
      SELECT scope FROM kernel.user_scope_grants
       WHERE user_id = ${ANNA} AND scope LIKE 'kernel:companies:%'`
    expect(direct.map((r) => r.scope)).toEqual(["kernel:companies:write"])
    // A holder's session picks the new scopes up on its next refresh.
    const [anna] = await fresh<{ v: number }[]>`
      SELECT permission_version AS v FROM kernel.users WHERE id = ${ANNA}`
    expect(anna?.v).toBe(versionBefore + 1)
  })

  test("a role, a direct grant or a routine that reads mail conversations since gets the opt-out list read too, its editor unchanged", async () => {
    // Mutation caught: the scope swap left later custom roles and stored routine scopes without
    // mail:suppressions:read, so their opt-out check refuses.
    const late = crypto.randomUUID()
    const bob = crypto.randomUUID()
    await fresh.unsafe(
      insertSql("kernel.users", {
        id: bob,
        org_id: ORG_ID,
        email: "bob@example.com",
        name: "Bob",
        status: "active",
      }),
    )
    await fresh.unsafe(
      insertSql("kernel.roles", { id: late, org_id: ORG_ID, name: "late readers" }),
    )
    await fresh.unsafe(
      insertSql("kernel.role_scope_grants", { role_id: late, scope: "mail:conversations:read" }),
    )
    await fresh.unsafe(
      insertSql("kernel.user_roles", { user_id: bob, role_id: late, org_id: ORG_ID }),
    )
    await fresh.unsafe(
      insertSql("kernel.user_scope_grants", {
        user_id: ANNA,
        org_id: ORG_ID,
        scope: "mail:conversations",
      }),
    )
    const reads = crypto.randomUUID()
    const other = crypto.randomUUID()
    const edited = new Date("2026-01-02T03:04:05.678Z")
    for (const [id, scopes, editedAt] of [
      [reads, ["mail:conversations:read", "kernel:contacts:read"], null],
      [other, ["tickets:tickets:read"], edited],
    ] as const) {
      const scopeArray = { raw: `ARRAY[${scopes.map((s) => `'${s}'`).join(", ")}]::text[]` }
      await fresh.unsafe(
        insertSql("kernel.routines", {
          id,
          org_id: ORG_ID,
          owner_user_id: ANNA,
          name: `r-${id.slice(0, 6)}`,
          description: "d",
          prompt: "p",
          cron: "0 8 * * 1-5",
          timezone: "UTC",
          scopes: scopeArray,
          inferred_scopes: scopeArray,
          created_by_user_id: ANNA,
          created_by_actor_type: "user",
          edited_at: editedAt ? editedAt.toISOString() : null,
        }),
      )
    }
    const [before] = await fresh<{ v: number }[]>`
      SELECT permission_version AS v FROM kernel.users WHERE id = ${bob}`

    const all = folderUpTo(SCOPE_TAG, 0)
    folders.push(all)
    await withRoleCatalogLock(adminUrl, () =>
      runMigrations(freshAsLogin.toString(), { migrationsFolder: all }),
    )

    const role = await fresh<{ scope: string }[]>`
      SELECT scope FROM kernel.role_scope_grants WHERE role_id = ${late} ORDER BY scope`
    expect(role.map((r) => r.scope)).toEqual(["mail:conversations:read", "mail:suppressions:read"])
    const direct = await fresh<{ scope: string }[]>`
      SELECT scope FROM kernel.user_scope_grants
       WHERE user_id = ${ANNA} AND scope LIKE 'mail:%' ORDER BY scope`
    expect(direct.map((r) => r.scope)).toEqual(["mail:conversations", "mail:suppressions:read"])
    const routines = await fresh<
      {
        id: string
        scopes: string[]
        inferred_scopes: string[]
        edited_at: Date | null
        edited_by_user_id: string | null
      }[]
    >`
      SELECT id, scopes, inferred_scopes, edited_at, edited_by_user_id FROM kernel.routines
       WHERE id IN (${reads}, ${other})`
    const r = routines.find((x) => x.id === reads)
    expect(r?.scopes).toEqual([
      "mail:conversations:read",
      "kernel:contacts:read",
      "mail:suppressions:read",
    ])
    expect(r?.inferred_scopes).toContain("mail:suppressions:read")
    // Still nobody's edit: the creator stays its last editor.
    expect(r?.edited_at).toBeNull()
    expect(r?.edited_by_user_id).toBeNull()
    const o = routines.find((x) => x.id === other)
    expect(o?.scopes).toEqual(["tickets:tickets:read"])
    expect(o?.edited_at?.toISOString()).toBe(edited.toISOString())
    const [after] = await fresh<{ v: number }[]>`
      SELECT permission_version AS v FROM kernel.users WHERE id = ${bob}`
    expect(after?.v).toBe((before?.v ?? 0) + 1)
  }, 60_000)

  test("users company foreign key refuses deleting a company an external user points at", async () => {
    const company = crypto.randomUUID()
    const external = crypto.randomUUID()
    await fresh.unsafe(
      insertSql("kernel.companies", {
        id: company,
        org_id: ORG_ID,
        handle: "maison-arlon",
        name: "Maison Arlon",
        created_by: ANNA,
      }),
    )
    await fresh.unsafe(
      insertSql("kernel.users", {
        id: external,
        org_id: ORG_ID,
        email: "client@example.com",
        name: "Client",
        user_type: "external",
        company_id: company,
      }),
    )
    await expect(fresh`DELETE FROM kernel.companies WHERE id = ${company}`).rejects.toThrow(
      "users_company_fk",
    )
    // A user pointing at no company at all is refused too.
    await expect(
      fresh.unsafe(
        insertSql("kernel.users", {
          id: crypto.randomUUID(),
          org_id: ORG_ID,
          email: "nobody@example.com",
          name: "Nobody",
          user_type: "external",
          company_id: crypto.randomUUID(),
        }),
      ),
    ).rejects.toThrow("users_company_fk")
  })
})
