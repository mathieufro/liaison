// SPDX-License-Identifier: FSL-1.1-ALv2
// The company and deal import kinds: listed, a dry run writes nothing and
// refuses what the run refuses, rows land through the product's services, and
// an undo removes what the run created (and keeps a company others now use).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { extractRows, sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { listImportKinds } from "~/modules/imports/kinds"
import { runImport } from "~/modules/imports/runner"
import type { SourceItem } from "~/modules/imports/source"
import { undoImportRun } from "~/modules/imports/undo"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let adminId = ""
const tag = () => crypto.randomUUID().slice(0, 8)

function operator(scopes: string[] = ["*"]): UserContext {
  return {
    actorType: "user",
    userId: adminId,
    orgId,
    scopes,
    dimensionGrants: { "*": ["*"] },
  }
}

function recordsOf(records: Array<Record<string, unknown>>) {
  const items: SourceItem[] = records.map((record, i) => ({ line: i + 1, record }))
  return { type: "records" as const, records: items }
}

function errorsByKey(run: { errors?: Array<{ dedupKey?: string; error?: string }> } | unknown) {
  const out: Record<string, string> = {}
  for (const e of ((run as { errors?: unknown[] }).errors ?? []) as Array<{
    dedupKey?: string
    key?: string
    error?: string
    message?: string
  }>) {
    out[String(e.dedupKey ?? e.key)] = String(e.error ?? e.message)
  }
  return out
}

const run = (
  kinds: string[],
  records: Array<Record<string, unknown>>,
  label: string,
  dryRun: boolean,
  actor: UserContext = operator(),
) =>
  runImport({
    orgId,
    actor,
    kinds,
    source: recordsOf(records),
    sourceLabel: label,
    mode: "cli",
    dryRun,
  })

const countCompanies = async (label: string) =>
  Number(
    (
      await sql`SELECT count(*)::int AS n FROM kernel.companies
                WHERE org_id = ${orgId} AND metadata->'externalIds' ? ${label}`
    )[0]?.n ?? 0,
  )

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: `imp-cd-${tag()}`, name: "Company Deal Import" })).orgId
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

describe("company and deal kinds", () => {
  it("company and deal kinds are listed, preview dry-runs and undo removes what was imported", async () => {
    const listed = (await listImportKinds(orgId)).map((k) => k.kind)
    expect(listed).toContain("contacts.company")
    expect(listed).toContain("projects.deal")

    const label = `crm${tag()}`
    const companies = [
      {
        externalId: "C-1",
        name: `Maison Arlon ${label}`,
        domain: `https://www.arlon-${label}.example/`,
      },
      { externalId: "C-2", name: `Second ${label}`, domain: "not a domain" },
      { externalId: "C-3", name: `Third ${label}` },
    ]
    const preview = await run(["contacts.company"], companies, label, true)
    expect(preview.counts["contacts.company"]).toEqual({ created: 2, skipped: 0, failed: 1 })
    expect(errorsByKey(preview)["C-2"]).toMatch(/is not a domain/)
    expect(await countCompanies(label)).toBe(0)

    const real = await run(["contacts.company"], companies, label, false)
    expect(real.counts["contacts.company"]).toEqual({ created: 2, skipped: 0, failed: 1 })
    expect(await countCompanies(label)).toBe(2)
    // A second run skips what is there.
    expect(
      (await run(["contacts.company"], companies, label, false)).counts["contacts.company"],
    ).toEqual({ created: 0, skipped: 2, failed: 1 })

    const deals = [
      {
        externalRef: "D-1",
        pipeline: `Pipe ${label}`,
        title: "First deal",
        stage: "Proposal",
        companyName: `Maison Arlon ${label}`,
        amountMinor: 120_000,
        currency: "EUR",
      },
      { externalRef: "D-2", pipeline: `Pipe ${label}`, title: "Bad stage", stage: "Nowhere" },
    ]
    const dealPreview = await run(["projects.deal"], deals, label, true)
    expect(dealPreview.counts["projects.deal"]).toEqual({ created: 1, skipped: 0, failed: 1 })
    expect(errorsByKey(dealPreview)["D-2"]).toMatch(/no stage "Nowhere"/)
    const none =
      await sql`SELECT 1 FROM app_projects.projects WHERE org_id = ${orgId} AND name = ${`Pipe ${label}`}`
    expect(none).toHaveLength(0)

    const dealRun = await run(["projects.deal"], deals, label, false)
    expect(dealRun.counts["projects.deal"]).toEqual({ created: 1, skipped: 0, failed: 1 })
    const rows = extractRows<{
      outcome: string
      company_id: string | null
      amount_minor: string
      currency: string
      stage: string
    }>(
      await sql`SELECT d.outcome, d.company_id, v.amount_minor, v.currency, s.label AS stage
                FROM app_projects.deals d
                JOIN app_projects.deal_values v ON v.task_id = d.task_id
                JOIN app_projects.tasks t ON t.id = d.task_id
                JOIN app_projects.project_statuses s ON s.id = t.status_id
                WHERE t.org_id = ${orgId} AND t.external_ref LIKE ${`${label}:deal:%`}`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.stage).toBe("Proposal")
    expect(rows[0]?.company_id).not.toBeNull()
    expect(Number(rows[0]?.amount_minor)).toBe(120_000)

    // The company is used by the deal: undoing the company run keeps it.
    const companyRun = real.runId
    const keep = await undoImportRun(orgId, companyRun, { userId: adminId })
    expect(keep.refused.some((r) => r.reason === "still_referenced")).toBe(true)
    // Undo of the deal run removes the deal with its amount and pipeline.
    const undone = await undoImportRun(orgId, dealRun.runId, { userId: adminId })
    expect(undone.refused).toEqual([])
    expect(
      await sql`SELECT 1 FROM app_projects.tasks WHERE org_id = ${orgId} AND external_ref LIKE ${`${label}:deal:%`}`,
    ).toHaveLength(0)
    expect(
      await sql`SELECT 1 FROM app_projects.deals WHERE org_id = ${orgId} AND company_id IS NOT NULL
                AND task_id NOT IN (SELECT id FROM app_projects.tasks WHERE org_id = ${orgId})`,
    ).toHaveLength(0)
  }, 120_000)

  it("a contact row with a company name and domain links to that company", async () => {
    const label = `cc${tag()}`
    const domain = `acme-${label}.example`
    const records = [
      {
        externalId: "P-1",
        name: "Pat One",
        email: `pat@${domain}`,
        companyName: `Acme ${label}`,
        companyDomain: domain,
      },
      { externalId: "P-2", name: "Quinn Two", email: `quinn@${domain}`, companyDomain: domain },
      {
        externalId: "P-3",
        name: "Rae Three",
        email: `rae@x-${label}.example`,
        companyDomain: `only-${label}.example`,
      },
    ]
    const preview = await run(["contacts.contact"], records, label, true)
    expect(preview.counts["contacts.contact"]).toEqual({ created: 2, skipped: 0, failed: 1 })
    expect(errorsByKey(preview)["P-3"]).toMatch(/Give companyName as well/)

    const real = await run(["contacts.contact"], records, label, false)
    expect(real.counts["contacts.contact"]).toEqual({ created: 2, skipped: 0, failed: 1 })
    const linked = extractRows<{ email: string; company: string; company_id: string }>(
      await sql`SELECT email, company, company_id::text AS company_id FROM kernel.contacts
                WHERE org_id = ${orgId} AND email LIKE ${`%@${domain}`} ORDER BY email`,
    )
    expect(linked).toHaveLength(2)
    expect(linked[0]?.company).toBe(`Acme ${label}`)
    expect(linked[0]?.company_id).toBe(linked[1]?.company_id as string)
    const companies =
      await sql`SELECT 1 FROM kernel.companies WHERE org_id = ${orgId} AND domain = ${domain}`
    expect(companies).toHaveLength(1)

    // Without company write access the company is not created, in plain words.
    const narrow = operator(["kernel:contacts:write", "kernel:imports:run"])
    const refused = await run(
      ["contacts.contact"],
      [
        {
          externalId: "P-9",
          name: "Sam Nine",
          email: `sam@n-${label}.example`,
          companyName: `Nope ${label}`,
        },
      ],
      label,
      true,
      narrow,
    )
    expect(errorsByKey(refused)["P-9"]).toMatch(/needs company write access/)

    const undone = await undoImportRun(orgId, real.runId, { userId: adminId })
    expect(undone.refused).toEqual([])
    expect(
      await sql`SELECT 1 FROM kernel.companies WHERE org_id = ${orgId} AND domain = ${domain}`,
    ).toHaveLength(0)
  }, 120_000)

  it("a company the importer cannot see is never matched, named or linked into", async () => {
    // Mutation caught: imports found companies with no visibility check, so a guessed domain
    // read back a restricted company's name and id, and linked rows into it.
    const label = `rs${tag()}`
    const domain = `secret-${label}.example`
    const secretName = `Confidential Target ${label}`
    const other = (
      await ensureUser({
        orgId,
        email: `other-${tag()}@fabrikam.example`,
        name: "Other",
        password: "pw-import-2!",
        role: "member",
      })
    ).userId
    const hidden = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.companies", {
        id: hidden,
        org_id: orgId,
        handle: `@co-${label}`,
        name: secretName,
        domain,
        created_by: other,
        org_access: "none",
      }),
    )
    const records = [{ externalId: "S-1", name: secretName, domain }]
    const companyRun = await run(["contacts.company"], records, label, false)
    expect(companyRun.counts["contacts.company"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const contactRun = await run(
      ["contacts.contact"],
      [
        {
          externalId: "S-2",
          name: "Sid Two",
          email: `sid@${domain}`,
          companyName: secretName,
          companyDomain: domain,
        },
      ],
      label,
      false,
    )
    expect(contactRun.counts["contacts.contact"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    expect(JSON.stringify([companyRun, contactRun])).not.toContain(hidden)
    const [linked] = await sql<{ company_id: string | null }[]>`
      SELECT company_id::text AS company_id FROM kernel.contacts
       WHERE org_id = ${orgId} AND email = ${`sid@${domain}`}`
    expect(linked?.company_id).not.toBe(hidden)
    const people = await sql`SELECT 1 FROM kernel.contacts WHERE company_id = ${hidden}`
    expect(people).toHaveLength(0)
  }, 120_000)
})
