// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The FIRST app registration of an org after boot must land the manifest's
// shape on whatever is already in the database.
//
// `register-schema-drift.test.ts` covers the second call in one process (the
// memoized fast path, where a pg_catalog probe decides whether to re-register).
// That path is unreachable in production: `ensureAppsForOrg` short-circuits on
// `initializedOrgRuntimes` and nothing else re-enters registration. So the only
// reconcile production ever gets is this one, on the boot path, and nothing
// pinned it: the claim that a restore or an operator drop is repaired at the
// next start rested on reading the DDL, not on running it.
//
// It holds. The registration body reaches CREATE TABLE IF NOT EXISTS and
// ALTER TABLE ADD COLUMN IF NOT EXISTS on every first call of a process, for an
// org whose `kernel.apps` row and schema hash already exist, so the drifted
// shape is repaired without the memoized-path probe being involved at all.
// What still has no trigger is drift that appears INSIDE a long-lived process:
// there, a repair waits for the next restart.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows } from "~/db"
import { __privileged_db__ as db, sql } from "~/db/connection"
import { withSchemaAdmin } from "~/db/privileged"
import {
  initializedOrgRuntimes,
  registeredApps,
  registeredAppVersions,
} from "~/modules/apps/app-registries"
import { initAppsForOrg } from "~/modules/apps/init"
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
  mailLock = await acquireAppSchemaJsLock("app_mail")
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Boot Drift Org', ${`boot-drift-org-${Date.now()}`})
      RETURNING id
    `),
  )
  orgId = org.id
})

afterAll(async () => {
  await releaseAppSchema("app_mail")
  await releaseAppSchemaJsLock("app_mail")
  await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
})

describe("the boot registration reconciles a schema that drifted while the process was down", () => {
  it("adds the manifest columns a narrow conversations table is missing", async () => {
    // A process that has already run: the org is initialized, the app is
    // registered, `kernel.apps` carries its row and its schema hash.
    await initAppsForOrg(orgId, [mailOnlyManifest])

    // The database as a restore or an operator drop leaves it while the process
    // is down: a narrow table under the app's own schema name.
    await takeOverAppSchema("app_mail", { lock: mailLock })
    await sql.unsafe(`GRANT ALL ON SCHEMA app_mail TO liaison_rls, liaison_app, liaison_admin`)
    // Owned by liaison_admin, the role a registered app's tables belong to: a
    // table owned by the connection role would refuse the reconcile for an
    // ownership reason with no production counterpart.
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
    expect(before.has("message_count")).toBe(false)

    // The process restarts: nothing in memory remembers the registration, and
    // the only reconcile production ever reaches is this first call.
    registeredApps.delete(`${orgId}:mail`)
    registeredAppVersions.delete(`${orgId}:mail`)
    initializedOrgRuntimes.delete(orgId)
    await initAppsForOrg(orgId, [mailOnlyManifest])

    const after = await liveColumns("conversations")
    for (const col of ["subject", "snippet", "labels", "is_read", "message_count"]) {
      expect({ column: col, present: after.has(col) }).toEqual({ column: col, present: true })
    }
    // And a table the narrow shape did not carry at all is created.
    expect((await liveColumns("accounts")).size).toBeGreaterThan(0)
  }, 120_000)
})
