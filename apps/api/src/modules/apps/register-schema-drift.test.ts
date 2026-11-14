// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A registered app's live tables must match its manifest after `registerApps`,
// whatever shape they were in before the call.
//
// The runtime memoizes registration per (org, app) in process memory and, when
// the version is unchanged, returns before any DDL runs. That memo says nothing
// about the DATABASE: a table that lost columns (a fixture that took the schema
// over, a partial restore, a hand-rolled narrow table installed by an earlier
// file) stays narrow for the life of the process, and every later caller reads a
// shape the manifest does not describe. The ALTER TABLE ADD COLUMN IF NOT EXISTS
// path that would repair it is never reached.
//
// Fails-without-fix: the second `registerApps` short-circuits on the memo and
// `subject` / `labels` / `message_count` are still missing from the narrow
// `app_mail.conversations`.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows } from "~/db"
import { __privileged_db__ as db, sql } from "~/db/connection"
import { withSchemaAdmin } from "~/db/privileged"
import { registerApps } from "~/modules/apps/runtime"
import { releaseAppSchema, takeOverAppSchema } from "~/tests/helpers/app-schema-fixture"
import {
  type AppSchemaLockHandle,
  acquireAppSchemaJsLock,
  releaseAppSchemaJsLock,
} from "~/tests/helpers/app-schema-lock"

// The handle the JS lock hands back: the take-over below re-enters THIS
// file's lock with it, rather than being skipped past on the strength of
// "somebody holds app_mail", which says nothing about who.
let mailLock: AppSchemaLockHandle

let orgId: string

// Without the tables whose read policies a migration owns (`rlsGovernedByMigration`), and their entities:
// the fixture schema below carries no migration's policies, so registration would
// rightly refuse to create those tables there, readable by administrators only.
const { messages: _messages, drafts: _drafts, ...ownTables } = (mailAppManifest as any).schema
const { message: _message, draft: _draft, ...ownEntities } = (mailAppManifest as any).entities ?? {}
const mailOnlyManifest = {
  ...(mailAppManifest as any),
  dependencies: { ...((mailAppManifest as any).dependencies ?? {}), tools: [] },
  schema: ownTables,
  entities: ownEntities,
}

async function liveColumns(table: string): Promise<Set<string>> {
  const rows = extractRows<{ column_name: string }>(
    await db.execute(drizzleSql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app_mail' AND table_name = ${table}
    `),
  )
  return new Set(rows.map((r) => r.column_name))
}

beforeAll(async () => {
  // JS-only: `registerApps` takes the Postgres advisory DDL lock on its own
  // connection, so holding that same lock here would deadlock the call.
  mailLock = await acquireAppSchemaJsLock("app_mail")
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Schema Drift Org', ${`schema-drift-org-${Date.now()}`})
      RETURNING id
    `),
  )
  orgId = org.id
})

afterAll(async () => {
  await releaseAppSchema("app_mail")
  await releaseAppSchemaJsLock("app_mail")
})

describe("registerApps reconciles a drifted live table", () => {
  it("adds the manifest columns a narrow conversations table is missing", async () => {
    // First registration: the app is now memoized for this process.
    await registerApps([mailOnlyManifest], orgId)

    // The live schema drifts to a narrow peer shape under the memo's feet.
    await takeOverAppSchema("app_mail", { lock: mailLock })
    // The fixture schema is brand new and owned by the test role: the
    // registration path only grants USAGE, so without CREATE here its DDL is
    // refused for a reason that has nothing to do with what is under test.
    await sql.unsafe(`GRANT ALL ON SCHEMA app_mail TO liaison_rls, liaison_app, liaison_admin`)
    // Created as liaison_admin, the role every registered app table is owned
    // by: a fixture table owned by the connection role would refuse the
    // reconcile for an ownership reason that has no production counterpart.
    await withSchemaAdmin(orgId, "fixture:narrow-conversations", async (tx) => {
      await tx.execute(
        drizzleSql.raw(`
          CREATE TABLE app_mail.conversations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            account_id UUID NOT NULL,
            external_thread_id TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `),
      )
    })
    const before = await liveColumns("conversations")
    expect(before.has("subject")).toBe(false)
    expect(before.has("labels")).toBe(false)

    await registerApps([mailOnlyManifest], orgId)

    const after = await liveColumns("conversations")
    for (const col of ["subject", "snippet", "labels", "is_read", "message_count"]) {
      expect({ column: col, present: after.has(col) }).toEqual({ column: col, present: true })
    }
    // A table the narrow fixture did not carry at all is created too.
    expect((await liveColumns("accounts")).size).toBeGreaterThan(0)
  })
})
