// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0117 moves Knowledge's per-document shares onto the generic grants table and
// gives contacts the sharing columns. The live database is already migrated,
// so the file is replayed inside ONE transaction that is rolled back: the old
// share tables are recreated with rows, legacy contacts are inserted, the
// migration's own statements run again (proving they are re-runnable), and
// the outcome is checked before the rollback leaves nothing behind.

import { afterAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0117_resource_sharing.sql", import.meta.url).pathname

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

class Rollback extends Error {}

afterAll(async () => {
  await sql.end()
})

describe("0117 resource sharing", () => {
  it("copies Knowledge shares to grants, keeps contacts org-wide and gives them their creator as owner", async () => {
    const statements = readFileSync(FILE, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    let checked = false
    await sql
      .begin(async (tx) => {
        const [org] = await tx`
          INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'mig0117', ${`mig0117-${crypto.randomUUID().slice(0, 8)}`})
          RETURNING id`
        const [user] = await tx`
          INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
          VALUES (gen_random_uuid(), ${org.id}, 'mig0117@x.example', 'Mig', 'active', 'h')
          RETURNING id`
        const doc = crypto.randomUUID()
        const role = crypto.randomUUID()
        // The two pre-0117 share tables, as 0002 / 0004 left them (no FK to
        // documents: the copy reads their columns only).
        await tx.unsafe(`
          CREATE TABLE app_knowledge.document_shares (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
            document_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL);
          CREATE TABLE app_knowledge.document_role_shares (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
            document_id uuid NOT NULL, role_id uuid NOT NULL, role text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL)`)
        await tx`
          INSERT INTO app_knowledge.document_shares (org_id, document_id, user_id, role, created_by)
          VALUES (${org.id}, ${doc}, ${user.id}, 'editor', ${user.id})`
        await tx`
          INSERT INTO app_knowledge.document_role_shares (org_id, document_id, role_id, role, created_by)
          VALUES (${org.id}, ${doc}, ${role}, 'viewer', ${user.id})`
        // Legacy contacts: one a person made, one the mail sync made.
        const [byPerson] = await tx`
          INSERT INTO kernel.contacts (org_id, handle, email, created_by)
          VALUES (${org.id}, 'mig0117-a', 'a@mig.example', ${user.id}) RETURNING id`
        const [bySystem] = await tx`
          INSERT INTO kernel.contacts (org_id, handle, email)
          VALUES (${org.id}, 'mig0117-b', 'b@mig.example') RETURNING id`

        for (const statement of statements) await tx.unsafe(statement)

        const grants = await tx`
          SELECT grantee_kind, grantee, role FROM kernel.resource_grants
           WHERE resource_type = 'knowledge.document' AND resource_id = ${doc}
           ORDER BY grantee_kind`
        expect([...grants]).toEqual([
          { grantee_kind: "role", grantee: role, role: "viewer" },
          { grantee_kind: "user", grantee: user.id, role: "editor" },
        ])
        const [tables] = await tx`
          SELECT to_regclass('app_knowledge.document_shares') AS s,
                 to_regclass('app_knowledge.document_role_shares') AS r`
        expect(tables).toEqual({ s: null, r: null })
        const contacts = await tx`
          SELECT id, org_access, org_wide, owner_user_id FROM kernel.contacts
           WHERE org_id = ${org.id} ORDER BY handle`
        expect([...contacts]).toEqual([
          { id: byPerson.id, org_access: "editor", org_wide: true, owner_user_id: user.id },
          { id: bySystem.id, org_access: "editor", org_wide: true, owner_user_id: null },
        ])
        const types = await tx`
          SELECT resource_type FROM kernel.shareable_resource_types ORDER BY 1`
        expect(types.map((t) => t.resource_type)).toEqual([
          "kernel.company",
          "kernel.contact",
          "kernel.dashboard",
          "kernel.dashboard_table",
          "knowledge.document",
        ])
        checked = true
        throw new Rollback()
      })
      .catch((err) => {
        if (!(err instanceof Rollback)) throw err
      })
    expect(checked).toBe(true)
  }, 60_000)
})
