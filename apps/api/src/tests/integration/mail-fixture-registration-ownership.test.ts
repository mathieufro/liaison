// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `mail-api.test.ts` and `mail-sync.test.ts` hand-rolled `app_mail` (and
// `app_tickets.tickets`) with CREATE TABLE IF NOT EXISTS and never registered
// the app. Against a database where the real app is installed those statements
// are silent no-ops, so both files ran their routes, their RLS, their triggers
// and their constraint coverage against whatever shape happened to be there,
// and passed by accident. Put a narrow peer shape in front of them and they
// collapse.
//
// This drives the real thing: a narrow `app_mail.conversations` owned by the
// role registration runs as, then both files in a child `bun test`. They now
// register the real mail and tickets apps, so they own the shape they assert
// and the registration reconciles the narrow table to the manifest.
//
// Fails-without-fix: with the hand-rolled DDL the child dies on the missing
// columns (`subject`, `labels`, `message_count`, `app_mail.accounts` itself).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db, sql } from "~/db/connection"
import { withSchemaAdmin } from "~/db/privileged"
import {
  inheritedFixtureLockEnv,
  releaseAppSchema,
  takeOverAppSchema,
} from "~/tests/helpers/app-schema-fixture"
import {
  type AppSchemaLockHandle,
  acquireAppSchemaJsLock,
  releaseAppSchemaJsLock,
} from "~/tests/helpers/app-schema-lock"

// The handle the JS lock hands back: the take-over below re-enters THIS
// file's lock with it, rather than being skipped past on the strength of
// "somebody holds app_mail", which says nothing about who.
let mailLock: AppSchemaLockHandle

const TARGETS = [
  "src/tests/integration/mail-api.test.ts",
  "src/tests/integration/mail-sync.test.ts",
]

/**
 * The table statements of the initial migration's app_mail section, in order: from its
 * stub tables on, past the schema's own ownership and grants, which the take-over above
 * already settled.
 */
function migrationMailSection(): string[] {
  const text = readFileSync(
    join(import.meta.dir, "..", "..", "db", "migrations", "0000_initial.sql"),
    "utf8",
  )
  const section = text.indexOf("-- app_mail schema")
  const start = text.indexOf("DO $$", section)
  const end = text.indexOf("-- app_tickets schema", start)
  if (section < 0 || start < 0 || end < 0)
    throw new Error("the initial migration's app_mail section moved")
  return text
    .slice(start, end)
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.split("\n").some((l) => l.trim() !== "" && !l.trim().startsWith("--")))
}

// No `acquireAppSchemaLock` here: the child takes that same Postgres advisory
// lock through its own registration, so holding it across the spawn would
// deadlock on ourselves.
beforeAll(async () => {
  // Process-local serialization only: peers in this bun process must not read
  // app_mail while the fixture holds it. The Postgres advisory lock stays free
  // because the child takes it through its own registration.
  mailLock = await acquireAppSchemaJsLock("app_mail")
})

afterAll(async () => {
  await releaseAppSchema("app_mail")
  await releaseAppSchemaJsLock("app_mail")
})

describe("the mail integration files own the app_mail schema they assert", () => {
  it("stay green when a narrow app_mail.conversations is already installed", async () => {
    const [org] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Mail Fixture Org', ${`mail-fixture-org-${Date.now()}`})
        RETURNING id
      `),
    )

    await takeOverAppSchema("app_mail", { lock: mailLock })
    // A fresh fixture schema is owned by the connection role. Registration runs
    // as liaison_admin, which owns every app table in a real database: without
    // these grants the child would fail for an ownership reason that has no
    // production counterpart.
    await sql.unsafe(`GRANT ALL ON SCHEMA app_mail TO liaison_rls, liaison_app, liaison_admin`)
    await withSchemaAdmin(org.id, "fixture:narrow-mail-conversations", async (tx) => {
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
      // Everything else the migrations put in app_mail, as a real database has it: the
      // stub tables they create when absent and the policies of the tables whose access
      // they own (messages, drafts). Registration refuses a migration-governed table no
      // policy grants, so a schema without them is a state no database is ever in.
      for (const statement of migrationMailSection()) {
        await tx.execute(drizzleSql.raw(statement))
      }
    })

    const child = Bun.spawn(["bun", "test", "--timeout", "120000", ...TARGETS], {
      cwd: process.cwd(),
      // The child takes the same schema over: it inherits the ownership lock
      // this file holds instead of queueing on it.
      env: { ...process.env, ...inheritedFixtureLockEnv(["app_mail"]) },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) {
      // The child's debug log buries its failures: name them first, with each one's error.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour escapes is the point
      const plain = `${out}\n${err}`.replace(/\x1b\[[0-9;]*m/g, "")
      const failures = plain
        .split("\n")
        .filter((l) => !l.startsWith('{"level"'))
        .filter((l) => /^\(fail\)|^✗|^error:|^\s*(Expected|Received)/.test(l))
        .join("\n")
      throw new Error(
        `child "bun test ${TARGETS.join(" ")}" exited ${code} against a narrow app_mail.conversations\n${failures}\n${out.slice(-1500)}`,
      )
    }
    expect(code).toBe(0)
    // A child that ran nothing also exits 0: pin that both files ran.
    expect(`${out}${err}`).toContain("across 2 files")
  }, 300_000)
})
