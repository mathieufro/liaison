// SPDX-License-Identifier: FSL-1.1-ALv2
// The built-in import kinds (P3a T4, T5): tickets.ticket, projects.task,
// projects.project and contacts.contact write through the runner, record every
// row they create in the ledger, dedup by `<source>:<key>` and skip rows an
// earlier CLI run imported with the bare key.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { runTicketsImport } from "~/cli/tickets/import"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { BUILTIN_IMPORT_HANDLERS } from "~/modules/imports/builtin-import-handlers"
import { BUILTIN_IMPORT_KINDS } from "~/modules/imports/builtin-kinds"
import { KERNEL_IMPORT_KINDS } from "~/modules/imports/kernel-kinds"
import { listImportKinds } from "~/modules/imports/kinds"
import { runImport } from "~/modules/imports/runner"
import type { SourceItem } from "~/modules/imports/source"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let slug = ""
let adminId = ""

function operator(): UserContext {
  return {
    actorType: "user",
    userId: adminId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }
}

function recordsOf(records: Array<Record<string, unknown>>): {
  type: "records"
  records: SourceItem[]
} {
  return { type: "records", records: records.map((record, i) => ({ line: i + 1, record })) }
}

const tag = () => crypto.randomUUID().slice(0, 8)

async function ledgerTables(runId: string): Promise<string[]> {
  const rows = await sql`
    SELECT table_name FROM kernel.import_ledger WHERE run_id = ${runId} ORDER BY seq`
  return rows.map((r) => String(r.table_name))
}

beforeAll(async () => {
  await acquireTestLock()
  slug = `imp-kinds-${tag()}`
  orgId = (await ensureOrg({ slug, name: "Import Kinds Org" })).orgId
  adminId = (
    await ensureUser({
      orgId,
      email: `owner-${tag()}@fabrikam.example`,
      name: "Owner",
      password: "pw-import-1!",
      role: "admin",
    })
  ).userId
}, 120_000)
afterAll(releaseTestLock)

describe("built-in kinds: declarations", () => {
  it("every built-in kind has a host handler and the org lists it", async () => {
    const names = Object.keys(BUILTIN_IMPORT_KINDS).sort()
    expect(names).toEqual([
      "calendar.event",
      "contacts.company",
      "contacts.contact",
      "knowledge.collection",
      "knowledge.document",
      "projects.deal",
      "projects.project",
      "projects.task",
      "projects.template",
      "tickets.category",
      "tickets.reply-template",
      "tickets.ticket",
    ])
    // Every built-in and kernel kind has a host handler, and no handler is orphaned.
    expect(Object.keys(BUILTIN_IMPORT_HANDLERS).sort()).toEqual(
      [...names, ...Object.keys(KERNEL_IMPORT_KINDS)].sort(),
    )
    const listed = (await listImportKinds(orgId)).map((k) => k.kind)
    for (const n of names) expect(listed).toContain(n)
  }, 120_000)
})

describe("tickets.ticket", () => {
  it("ledgers the contact, the ticket, its messages and their files, and dedups", async () => {
    const ref = `SUP-${tag()}`
    const record = {
      subject: "Unit will not power on",
      externalRef: ref,
      contactEmail: `cust-${tag()}@contoso.example`,
      contactName: "Casey Customer",
      // A manual ticket with no inbound message keeps its requester as a
      // contact createTicket creates (create.ts): the run must ledger it.
      channel: "manual",
      team: "support-eu",
      messages: [
        {
          kind: "note",
          textBody: "It is dead.",
          attachments: [
            {
              filename: "photo.txt",
              mimeType: "text/plain",
              bytesBase64: Buffer.from("pic").toString("base64"),
            },
          ],
        },
        { kind: "outbound", textBody: "Hold the button.", sentAt: "2025-01-02T10:00:00Z" },
      ],
    }
    const run = () =>
      runImport({
        orgId,
        actor: operator(),
        kinds: ["tickets.ticket"],
        source: recordsOf([record]),
        sourceLabel: "jira",
        mode: "cli",
      })
    const first = await run()
    expect(first.counts["tickets.ticket"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const tables = await ledgerTables(first.runId)
    expect(tables[0]).toBe("kernel.contacts")
    expect(tables.filter((t) => t !== "kernel.resource_grants")).toEqual([
      "kernel.contacts",
      "app_tickets.tickets",
      "app_tickets.messages",
      "app_tickets.messages",
      "kernel.files",
    ])
    const stored = await sql`
      SELECT external_ref FROM app_tickets.tickets WHERE org_id = ${orgId} AND external_ref LIKE ${`%${ref}`}`
    expect(stored.map((r) => r.external_ref)).toEqual([`jira:${ref}`])
    const second = await run()
    expect(second.counts["tickets.ticket"]).toEqual({ created: 0, skipped: 1, failed: 0 })
    expect(await ledgerTables(second.runId)).toEqual([])
  })

  it("a ticket the CLI imported with the bare key is skipped by a labelled run (R9)", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "imp-legacy-"))
    try {
      const ref = `LEG-${tag()}`
      const file = join(dir, "t.ndjson")
      writeFileSync(
        file,
        `${JSON.stringify({ subject: "Legacy", externalRef: ref, messages: [{ textBody: "x" }] })}\n`,
      )
      const cli = await runTicketsImport({ file, orgSlug: slug, dryRun: false })
      expect(cli.report.created).toBe(1)
      const again = await runImport({
        orgId,
        actor: operator(),
        kinds: ["tickets.ticket"],
        source: recordsOf([{ subject: "Legacy", externalRef: ref, messages: [{ textBody: "x" }] }]),
        sourceLabel: "freshdesk",
        mode: "cli",
      })
      expect(again.counts["tickets.ticket"]).toEqual({ created: 0, skipped: 1, failed: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("projects.task and projects.project", () => {
  it("ledgers placeholders, the ensured project and statuses, the thread, participants, task and messages", async () => {
    const devEmail = `dev-${tag()}@fabrikam.example`
    await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${devEmail}, 'Dana Dev', 'active')`),
    )
    const project = `Board ${tag()}`
    const r = await runImport({
      orgId,
      actor: operator(),
      kinds: ["projects.task"],
      source: recordsOf([
        {
          externalRef: `PJ-${tag()}`,
          project: { name: project },
          title: "Ship it",
          reporterEmail: `gone-${tag()}@contoso.example`,
          reporterName: "Former Colleague",
          comments: [{ authorEmail: devEmail, body: "on it", createdAt: "2025-02-01T00:00:00Z" }],
        },
      ]),
      sourceLabel: "jira",
      mode: "cli",
      placeholders: true,
      kindOptions: { "projects.task": { deferIndexing: true } },
    })
    expect(r.counts["projects.task"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const tables = await ledgerTables(r.runId)
    expect(tables).toContain("kernel.users")
    expect(tables.indexOf("kernel.users")).toBeLessThan(tables.indexOf("app_projects.tasks"))
    expect(tables).toContain("app_projects.projects")
    expect(tables.filter((t) => t === "app_projects.project_statuses").length).toBeGreaterThan(0)
    expect(tables).toContain("kernel.threads")
    expect(tables).toContain("kernel.thread_participants")
    expect(tables).toContain("app_projects.tasks")
    expect(tables[tables.length - 1]).toBe("kernel.messages")
    expect(r.report.commentsImported).toBe(1)
  })

  it("projects.project creates by name with its statuses and skips an existing name", async () => {
    const name = `Roadmap ${tag()}`
    const rec = { name, statuses: [{ label: "Shipped", terminal: true }] }
    const first = await runImport({
      orgId,
      actor: operator(),
      kinds: ["projects.project"],
      source: recordsOf([rec]),
      sourceLabel: "jira",
      mode: "cli",
    })
    expect(first.counts["projects.project"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const labels = await sql`
      SELECT s.label FROM app_projects.project_statuses s
      JOIN app_projects.projects p ON p.id = s.project_id
      WHERE p.org_id = ${orgId} AND p.name = ${name}`
    expect(labels.map((l) => l.label)).toContain("Shipped")
    const tables = await ledgerTables(first.runId)
    expect(tables[0]).toBe("app_projects.projects")
    expect(tables.length).toBe(labels.length + 1)
    const again = await runImport({
      orgId,
      actor: operator(),
      kinds: ["projects.project"],
      source: recordsOf([rec]),
      sourceLabel: "jira",
      mode: "cli",
    })
    expect(again.counts["projects.project"]).toEqual({ created: 0, skipped: 1, failed: 0 })
  })
})

describe("contacts.contact", () => {
  async function contactsByEmail(email: string) {
    return extractRows<{ id: string; external_ids: Record<string, string> }>(
      await sql`SELECT id, external_ids FROM kernel.contacts WHERE org_id = ${orgId} AND lower(email) = ${email}`,
    )
  }

  it("dedups by source id; the same email from another source is skipped, untouched", async () => {
    const email = `pat-${tag()}@contoso.example`
    const id = `C-${tag()}`
    const run = (sourceLabel: string, externalId: string) =>
      runImport({
        orgId,
        actor: operator(),
        kinds: ["contacts.contact"],
        source: recordsOf([{ externalId, name: "Pat Partner", email }]),
        sourceLabel,
        mode: "cli",
      })
    const first = await run("jira", id)
    expect(first.counts["contacts.contact"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    expect(await ledgerTables(first.runId)).toEqual(["kernel.contacts"])
    expect((await run("jira", id)).counts["contacts.contact"]?.skipped).toBe(1)
    const other = await run("hubspot", "H-1")
    expect(other.counts["contacts.contact"]).toEqual({ created: 0, skipped: 1, failed: 0 })
    const rows = await contactsByEmail(email)
    expect(rows.length).toBe(1)
    expect(rows[0]!.external_ids).toEqual({ jira: id })
  })
})

describe("contacts.contact: never merges (skeptic MAJOR 2)", () => {
  it("a contact the org has by phone is skipped and left untouched", async () => {
    const phone = `+3361${Math.floor(Math.random() * 1e7)}`
    await sql`INSERT INTO kernel.contacts (org_id, handle, name, phone, org_access)
              VALUES (${orgId}, ${`@contact-p${tag()}`}, 'Phone Owner', ${phone}, 'editor')`
    const r = await runImport({
      orgId,
      actor: operator(),
      kinds: ["contacts.contact"],
      source: recordsOf([
        { externalId: `P-${tag()}`, name: "Someone Else", phone, company: "Contoso" },
      ]),
      sourceLabel: "crm",
      mode: "cli",
    })
    expect(r.counts["contacts.contact"]).toEqual({ created: 0, skipped: 1, failed: 0 })
    expect(await ledgerTables(r.runId)).toEqual([])
    const rows =
      await sql`SELECT name, company, external_ids FROM kernel.contacts WHERE org_id = ${orgId} AND phone = ${phone}`
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ name: "Phone Owner", company: null, external_ids: {} })
  })
})

describe("tickets.ticket: the team a ticket lands in (skeptic MINOR 5)", () => {
  it("a ticket inheriting a team outside the person's grant from its inbox is refused", async () => {
    const team = `team-${tag()}`
    await withPrivilegedDb(orgId, "t", async (tx) => {
      const accountId = crypto.randomUUID()
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (id, org_id, app_name, connection_name, owner_type, provider_type, identifier, status, created_by)
        VALUES (${accountId}::uuid, ${orgId}::uuid, 'tickets', 'imap', 'org', 'imap',
                ${`help-${tag()}@fabrikam.example`}, 'active', ${adminId}::uuid)`)
      await tx.execute(drizzleSql`
        UPDATE app_tickets.inboxes SET is_default_for_create = false WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes
          (org_id, name, connected_account_id, email_address, default_team, is_default_for_create)
        VALUES (${orgId}::uuid, 'Default', ${accountId}::uuid, ${`help-${tag()}@fabrikam.example`},
                ${team}, true)`)
    })
    const ref = `TM-${tag()}`
    const r = await runImport({
      orgId,
      actor: { ...operator(), dimensionGrants: { team: ["somewhere-else"] } },
      kinds: ["tickets.ticket"],
      source: recordsOf([
        { subject: "No team given", externalRef: ref, messages: [{ textBody: "x" }] },
      ]),
      sourceLabel: "tm",
      mode: "cli",
    })
    expect(r.counts["tickets.ticket"]).toEqual({ created: 0, skipped: 0, failed: 1 })
    expect(String(r.errors[0]?.error)).toMatch(/^out_of_scope/)
    expect(
      (await sql`SELECT id FROM app_tickets.tickets WHERE external_ref = ${`tm:${ref}`}`).length,
    ).toBe(0)
  })
})

describe("a preview runs the built-in kinds' own checks", () => {
  function errorsByKey(run: Awaited<ReturnType<typeof runImport>>): Record<string, string> {
    return Object.fromEntries(run.errors.map((e) => [String(e.dedupKey), String(e.error)]))
  }

  it("projects.task: refuses what the run refuses, passes a child of an earlier record, writes nothing", async () => {
    const label = `pv${tag()}`
    const project = { name: `Preview ${label}` }
    const records = [
      { externalRef: "P-1", project, title: "Parent" },
      { externalRef: "P-2", project, title: "Child", parentExternalRef: "P-1" },
      { externalRef: "P-3", project, title: "Orphan", parentExternalRef: "NOPE" },
      {
        externalRef: "P-4",
        project,
        title: "Bad comment",
        comments: [{ body: "x", createdAt: "yesterday" }],
      },
      {
        externalRef: "P-5",
        project,
        title: "Bad file",
        attachments: [{ filename: "setup.exe", fileId: crypto.randomUUID() }],
      },
    ]
    const run = (dryRun: boolean) =>
      runImport({
        orgId,
        actor: operator(),
        kinds: ["projects.task"],
        source: recordsOf(records),
        sourceLabel: label,
        mode: "cli",
        dryRun,
      })
    const preview = await run(true)
    expect(preview.counts["projects.task"]).toEqual({ created: 2, skipped: 0, failed: 3 })
    const refused = errorsByKey(preview)
    expect(refused["P-3"]).toMatch(/parentExternalRef "NOPE" does not resolve/)
    expect(refused["P-4"]).toMatch(/comments\[0\]\.createdAt is not a valid/)
    expect(refused["P-5"]).toMatch(/setup\.exe.*not accepted/)
    const written = await sql`
      SELECT 1 FROM app_projects.tasks WHERE org_id = ${orgId} AND external_ref LIKE ${`${label}:%`}`
    expect(written).toHaveLength(0)

    // The run refuses the same records, with the same words.
    const real = await run(false)
    expect(real.counts["projects.task"]).toEqual({ created: 2, skipped: 0, failed: 3 })
    expect(errorsByKey(real)).toEqual(refused)
  })

  it("tickets.ticket: a category that does not exist and a team outside the grant are refused", async () => {
    const label = `pt${tag()}`
    const narrow: UserContext = {
      ...operator(),
      dimensionGrants: { "tickets:team": ["support-eu"] },
    }
    const ticket = (ref: string, extra: Record<string, unknown> = {}) => ({
      subject: `Preview ${ref}`,
      externalRef: ref,
      channel: "manual",
      messages: [{ kind: "note", textBody: "hello" }],
      ...extra,
    })
    const records = [
      ticket("T-1", { team: "support-eu" }),
      ticket("T-2", { categoryPath: `Nowhere ${label} / Deep` }),
      ticket("T-3", { team: "sales-us" }),
    ]
    const run = (dryRun: boolean) =>
      runImport({
        orgId,
        actor: narrow,
        kinds: ["tickets.ticket"],
        source: recordsOf(records),
        sourceLabel: label,
        mode: "cli",
        dryRun,
      })
    const preview = await run(true)
    expect(preview.counts["tickets.ticket"]).toEqual({ created: 1, skipped: 0, failed: 2 })
    const refused = errorsByKey(preview)
    expect(refused["T-3"]).toMatch(/out_of_scope: team "sales-us"/)
    expect(refused["T-2"]).toBeDefined()
    const written = await sql`
      SELECT 1 FROM app_tickets.tickets WHERE org_id = ${orgId} AND external_ref LIKE ${`${label}:%`}`
    expect(written).toHaveLength(0)

    const real = await run(false)
    expect(real.counts["tickets.ticket"]).toEqual({ created: 1, skipped: 0, failed: 2 })
    expect(errorsByKey(real)).toEqual(refused)
  })

  it("tickets: a ticket may name a category an earlier record of the same preview creates", async () => {
    const label = `pc${tag()}`
    const path = `Hardware ${label} / Power`
    const dir = mkdtempSync(join(tmpdir(), "preview-categories-"))
    try {
      const file = join(dir, "export.ndjson")
      writeFileSync(
        file,
        [
          { kind: "tickets.category", record: { path } },
          {
            kind: "tickets.ticket",
            record: {
              subject: "Dead unit",
              externalRef: "C-1",
              channel: "manual",
              categoryPath: path,
              messages: [{ kind: "note", textBody: "dead" }],
            },
          },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n"),
      )
      const preview = await runImport({
        orgId,
        actor: operator(),
        kinds: ["tickets.category", "tickets.ticket"],
        source: { type: "path", path: file },
        sourceLabel: label,
        mode: "cli",
        dryRun: true,
      })
      expect(preview.counts["tickets.category"]).toEqual({ created: 1, skipped: 0, failed: 0 })
      expect(preview.counts["tickets.ticket"]).toEqual({ created: 1, skipped: 0, failed: 0 })
      const cats = await sql`
        SELECT 1 FROM app_tickets.categories WHERE org_id = ${orgId} AND name = ${`Hardware ${label}`}`
      expect(cats).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
