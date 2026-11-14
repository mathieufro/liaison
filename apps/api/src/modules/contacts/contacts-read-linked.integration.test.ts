// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's contact read names the records other apps hold for that person
// (a recurring schedule that bills them, an issued invoice), one line per app,
// read through each app's timeline source as the caller: what the caller's
// scopes or row security would not show is absent, never named. An app reading
// a contact app-to-app gets the contact alone, as before.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { ActivityTestAccess, readActivity } from "~/modules/contacts/activity"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const inv = (table: string) => `${schemaRef("app_invoicing")}.${table}`

type Row = Record<string, unknown>

const world = {
  org: "",
  admin: null as unknown as UserContext,
  clerk: null as unknown as UserContext,
  roleReader: null as unknown as UserContext,
  roleId: "",
  shared: "",
  sharedScheduleId: "",
  buyer: "",
  other: "",
  scheduleId: "",
  otherScheduleId: "",
  documentId: "",
}

async function insertRow(table: string, row: Record<string, RowValue>): Promise<void> {
  await sql.unsafe(insertSql(table, row))
}

function invoicingDescriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "invoicing", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _firstParty: true,
    _format: "manifest",
    _bundlePath: join(
      REPO_ROOT,
      "bundled-apps",
      "invoicing",
      String(manifest.version),
      "bundle.js",
    ),
  }
}

/** The person's agent reading the contact in a turn they typed. */
async function agentRead(actor: UserContext, contactId: string): Promise<Row> {
  const { executeTool } = await import("~/modules/apps/execute-tool")
  const runId = randomUUID()
  const frame: RunContext = {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    agentId: randomUUID(),
    turnScopeAccumulator: createTurnScopeAccumulator(),
    humanTurn: true,
  }
  const res = await runContextStore.run(frame, () =>
    executeTool<Row>({
      toolName: "kernel:contacts_read",
      orgId: world.org,
      actor,
      params: { contactId },
      origin: "in-app-agent",
    }),
  )
  return res.data as Row
}

const linesOf = (result: Row): string[] => (result.linkedRecords as string[] | undefined) ?? []

describe("the agent's contact read names other apps' records for the person", () => {
  beforeAll(async () => {
    await acquireTestLock()
    world.org = (await createTestOrg()).id
    const admin = await minimal.person(world.org, { role: "admin" })
    const clerk = await minimal.person(world.org, { role: "admin" })
    world.admin = {
      actorType: "user",
      userId: admin.id,
      orgId: world.org,
      scopes: ["kernel:contacts:read", "invoicing:documents:read"],
      dimensionGrants: {},
    }
    // The same person without the invoicing read.
    world.clerk = {
      actorType: "user",
      userId: clerk.id,
      orgId: world.org,
      scopes: ["kernel:contacts:read"],
      dimensionGrants: {},
    }
    // A third person who reads one restricted contact through a role they hold.
    const reader = await minimal.person(world.org, { role: "admin" })
    world.roleId = randomUUID()
    world.roleReader = {
      actorType: "user",
      userId: reader.id,
      orgId: world.org,
      scopes: ["kernel:contacts:read", "invoicing:documents:read"],
      dimensionGrants: {},
      roles: [world.roleId],
    }
    await initSandboxPool()
    await initWorkerPool()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    await registerApps([invoicingDescriptor() as never], world.org)

    const tag = randomUUID().slice(0, 6)
    world.buyer = await minimal.contact(world.org, `buyer-${tag}@maison-${tag}.example`, {
      name: "Maison Belair",
    })
    world.other = await minimal.contact(world.org, `other-${tag}@maison-${tag}.example`, {
      name: "Maison Autre",
    })
    const issuer = randomUUID()
    await insertRow(inv("issuer_profiles"), {
      id: issuer,
      org_id: world.org,
      legal_name: `Maison Issuer ${tag}`,
      country: "FR",
      default_currency: "EUR",
    })
    const schedule = (id: string, contactId: string, unitMinor: number) =>
      insertRow(inv("recurring_schedules"), {
        id,
        org_id: world.org,
        issuer_profile_id: issuer,
        contact_id: contactId,
        repeats: "month",
        billing_day: "1",
        created_by: admin.id,
        lines: {
          raw: `'${JSON.stringify([{ description: "Retainer", qty: 1, unit_price_minor: unitMinor, vat_bp: 2000 }])}'::jsonb`,
        },
      })
    world.scheduleId = randomUUID()
    world.otherScheduleId = randomUUID()
    await schedule(world.scheduleId, world.buyer, 65000)
    await schedule(world.otherScheduleId, world.other, 99000)
    // Restricted to its owner, and shared to one role.
    world.shared = await minimal.contact(world.org, `shared-${tag}@maison-${tag}.example`, {
      name: "Maison Partagee",
    })
    await sql`UPDATE kernel.contacts SET org_access = 'none', owner_user_id = ${admin.id}
      WHERE id = ${world.shared}`
    await insertRow(`${schemaRef("kernel")}.resource_grants`, {
      org_id: world.org,
      resource_type: "kernel.contact",
      resource_id: world.shared,
      grantee_kind: "role",
      grantee: world.roleId,
      role: "viewer",
    })
    world.sharedScheduleId = randomUUID()
    await schedule(world.sharedScheduleId, world.shared, 42000)
    world.documentId = randomUUID()
    await insertRow(inv("documents"), {
      id: world.documentId,
      org_id: world.org,
      type: "invoice",
      status: "issued",
      issuer_profile_id: issuer,
      currency: "EUR",
      number: `INV-${tag}-1`,
      counterparty_contact_id: world.buyer,
      counterparty_name: "Maison Belair",
      issued_at: new Date().toISOString(),
      grand_total_minor: 78000,
    })
    // These tests read what the sources answer, not how fast: the agent's read
    // passes no deadline of its own, so on a loaded machine the shipped one
    // would turn an answer into "no answer in time".
    ActivityTestAccess.setDefaultDeadlineMs(60_000)
    // The sandbox's first call loads the app: done once here, with time to spare.
    await readActivity({
      orgId: world.org,
      actor: world.admin,
      target: { contactId: world.buyer },
      deadlineMs: 60_000,
    })
  }, 180_000)

  afterAll(async () => {
    ActivityTestAccess.setDefaultDeadlineMs(null)
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("a contact read names the recurring schedule that bills the contact, with its id", async () => {
    const lines = linesOf(await agentRead(world.admin, world.buyer))
    const invoices = lines.find((l) => l.startsWith("Invoices:"))
    expect(invoices).toBeDefined()
    expect(invoices).toContain(
      `1 schedule, newest "Recurring schedule, monthly, 650.00 before VAT" (invoicing schedule ${world.scheduleId})`,
    )
    expect(invoices).toContain(`(invoicing document ${world.documentId})`)
    // Another person's schedule is never on this person's read.
    expect(lines.join("\n")).not.toContain(world.otherScheduleId)
  }, 60_000)

  it("a record the caller cannot read is absent from the contact read", async () => {
    const result = await agentRead(world.clerk, world.buyer)
    expect((result.contact as Row).id).toBe(world.buyer)
    const text = JSON.stringify(result)
    expect(text).not.toContain(world.scheduleId)
    expect(text).not.toContain(world.documentId)
    expect(linesOf(result).some((l) => l.startsWith("Invoices"))).toBe(false)
  }, 60_000)

  it("a contact shared to a role the person holds names its records, read with that role", async () => {
    const result = await agentRead(world.roleReader, world.shared)
    expect((result.contact as Row).id).toBe(world.shared)
    const invoices = linesOf(result).find((l) => l.startsWith("Invoices:"))
    expect(invoices).toContain(`(invoicing schedule ${world.sharedScheduleId})`)
    expect(linesOf(result).join("\n")).not.toContain(world.scheduleId)

    // The same person without the role reads neither the contact nor its records.
    const without = agentRead({ ...world.roleReader, roles: [] }, world.shared)
    await expect(without).rejects.toMatchObject({ code: "NOT_FOUND" })
  }, 60_000)

  it("an app's contact read result is unchanged", async () => {
    const { executeToolCore } = await import("~/modules/apps/execute-tool")
    const res = await executeToolCore({
      toolName: "kernel:contacts_read",
      orgId: world.org,
      actor: world.admin,
      params: { contactId: world.buyer },
      origin: "in-app-agent",
      internalCall: { callerApp: "invoicing" },
    })
    expect("data" in res).toBe(true)
    const data = (res as { data: Row }).data
    expect(Object.keys(data).sort()).toEqual(["contact", "recentMailBacklinks", "recentTimeline"])
    expect(JSON.stringify(data)).not.toContain(world.scheduleId)
  }, 60_000)
})
