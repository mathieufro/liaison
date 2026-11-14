// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A company merge and a contact merge, under the real liaison_rls role, carry
// the Stripe customers and the recurring invoice schedules that named the
// merged record, in the merge's own transaction: nothing waits for an event
// a restart could lose, and an app turned off during the merge still has its
// rows moved (its tables stay).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type RlsClient, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { setOrgAppStatus } from "~/modules/apps/org-app-service"
import { registerApps } from "~/modules/apps/runtime"
import { createCompany, mergeCompanies } from "~/modules/contacts/companies"
import { mergeContactsWithMailReferences } from "~/modules/contacts/service"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = crypto.randomUUID()
const ANNA = crypto.randomUUID()
const ISSUER = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)

const SCOPES = [
  "kernel:contacts:read",
  "kernel:contacts:write",
  "kernel:companies:read",
  "kernel:companies:write",
  "stripe:customers:read",
  "stripe:customers:write",
  "invoicing:documents:read",
  "invoicing:documents:write",
]
const anna: UserContext = {
  actorType: "user",
  userId: ANNA,
  orgId: ORG_ID,
  scopes: SCOPES,
  dimensionGrants: {},
}
const asAnna = <T>(fn: (tx: RlsClient) => Promise<T>) => withRlsContext(anna, fn)
const insert = (table: string, rows: Record<string, RowValue> | Record<string, RowValue>[]) =>
  sql.unsafe(insertSql(table, rows))

let seq = 0

/** The registration-relevant part of a bundled app's manifest: its tables, scopes and roles. */
function tablesOf(name: string) {
  const m = JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "..",
        "..",
        "bundled-apps",
        name,
        "app.manifest.json",
      ),
      "utf8",
    ),
  )
  return {
    name: m.name,
    version: m.version,
    _format: "manifest" as const,
    _bundlePath: `/apps/${name}/handlers.js`,
    scopes: m.scopes,
    roles: m.roles,
    schema: m.schema,
  }
}

async function company(name: string): Promise<string> {
  const { company: row } = await asAnna((tx) =>
    createCompany(tx, { orgId: ORG_ID, userId: ANNA, input: { name } }),
  )
  return row.id
}

async function contact(companyId: string | null): Promise<string> {
  const id = crypto.randomUUID()
  seq += 1
  await insert("kernel.contacts", {
    id,
    org_id: ORG_ID,
    handle: `@spm-${id.slice(0, 8)}`,
    email: `client-${seq}-${id.slice(0, 6)}@maison.example`,
    name: `Client ${seq}`,
    org_access: "editor",
    created_by: ANNA,
    company_id: companyId,
  })
  return id
}

/** One Stripe customer and one recurring schedule, both naming this company and contact. */
async function linked(
  companyId: string,
  contactId: string,
): Promise<{ customer: string; schedule: string }> {
  const customer = `cus_${crypto.randomUUID().slice(0, 12)}`
  const schedule = crypto.randomUUID()
  await insert("app_stripe.stripe_customers", {
    org_id: ORG_ID,
    stripe_id: customer,
    email: "billing@maison.example",
    company_id: companyId,
    contact_id: contactId,
    match_method: "email",
    stripe_updated: "2026-11-01T00:00:00.000Z",
    created_at_stripe: "2026-01-01T00:00:00.000Z",
  })
  await insert("app_invoicing.recurring_schedules", {
    id: schedule,
    org_id: ORG_ID,
    issuer_profile_id: ISSUER,
    company_id: companyId,
    contact_id: contactId,
    repeats: "month",
    billing_day: "1",
    created_by: ANNA,
  })
  return { customer, schedule }
}

async function names(link: { customer: string; schedule: string }) {
  const [row] = await sql<Record<string, string | null>[]>`
    SELECT
      (SELECT company_id::text FROM app_stripe.stripe_customers WHERE stripe_id = ${link.customer}) AS customer_company,
      (SELECT contact_id::text FROM app_stripe.stripe_customers WHERE stripe_id = ${link.customer}) AS customer_contact,
      (SELECT company_id::text FROM app_invoicing.recurring_schedules WHERE id = ${link.schedule}) AS schedule_company,
      (SELECT contact_id::text FROM app_invoicing.recurring_schedules WHERE id = ${link.schedule}) AS schedule_contact`
  return row
}

beforeAll(async () => {
  await acquireTestLock()
  resetEventBus()
  initEventBus()
  DurableConsumersTestAccess.reset()
  registerEventSubscribers({
    bufferAndBroadcast: async () => {},
    broadcast: async () => {},
    closeConnectionsForUser: () => {},
  } as never)
  await insert("kernel.organizations", { id: ORG_ID, name: "Billing merge", slug: `spm-${tag}` })
  await insert("kernel.users", {
    id: ANNA,
    org_id: ORG_ID,
    email: `${ANNA.slice(0, 8)}@team.example`,
    name: "Anna Merge",
    status: "active",
    password_hash: "x",
    user_type: "member",
    company_id: null,
  })
  for (const scope of SCOPES)
    await insert("kernel.user_scope_grants", { user_id: ANNA, org_id: ORG_ID, scope })
  await ensureAppsForOrg(ORG_ID)
  await registerApps([tablesOf("stripe") as never, tablesOf("invoicing") as never], ORG_ID)
  for (const name of ["stripe", "invoicing"]) {
    await sql.unsafe(
      insertSql(
        "kernel.apps",
        { org_id: ORG_ID, name, version: "1.0.0" },
        { onConflictDoNothing: true },
      ),
    )
  }
  await insert("app_invoicing.issuer_profiles", {
    id: ISSUER,
    org_id: ORG_ID,
    legal_name: "Merge Issuer SAS",
    country: "FR",
    default_currency: "EUR",
  })
}, 120_000)

afterAll(async () => {
  await sql`DELETE FROM app_invoicing.recurring_schedules WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM app_stripe.stripe_customers WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`.catch(() => undefined)
  resetEventBus()
  resetAppRegistries()
  await releaseTestLock()
})

describe("merges carry Stripe customers and recurring schedules", () => {
  it("after a company or contact merge every linked Stripe customer and recurring schedule names the target, with the app off during the merge as well", async () => {
    // A company merge.
    const source = await company("Maison Lune")
    const target = await company("Lune Maison")
    const person = await contact(source)
    const byCompany = await linked(source, person)
    await asAnna((tx) =>
      mergeCompanies(tx, { orgId: ORG_ID, userId: ANNA, sourceId: source, targetId: target }),
    )
    expect(await names(byCompany)).toMatchObject({
      customer_company: target,
      schedule_company: target,
    })

    // A contact merge.
    const keep = await contact(target)
    const gone = await contact(target)
    const byContact = await linked(target, gone)
    await asAnna((tx) =>
      mergeContactsWithMailReferences(tx, {
        orgId: ORG_ID,
        userId: ANNA,
        sourceId: gone,
        targetId: keep,
      }),
    )
    expect(await names(byContact)).toMatchObject({ customer_contact: keep, schedule_contact: keep })

    // Both apps off while a company and a contact are merged: their rows still move.
    const offSource = await company("Verrerie Claire")
    const offTarget = await company("Claire Verrerie")
    const offGone = await contact(offSource)
    const offKeep = await contact(offTarget)
    const off = await linked(offSource, offGone)
    await setOrgAppStatus(ORG_ID, "stripe", "disabled")
    await setOrgAppStatus(ORG_ID, "invoicing", "disabled")
    try {
      await asAnna((tx) =>
        mergeCompanies(tx, {
          orgId: ORG_ID,
          userId: ANNA,
          sourceId: offSource,
          targetId: offTarget,
        }),
      )
      await asAnna((tx) =>
        mergeContactsWithMailReferences(tx, {
          orgId: ORG_ID,
          userId: ANNA,
          sourceId: offGone,
          targetId: offKeep,
        }),
      )
    } finally {
      await setOrgAppStatus(ORG_ID, "stripe", "active")
      await setOrgAppStatus(ORG_ID, "invoicing", "active")
    }
    expect(await names(off)).toEqual({
      customer_company: offTarget,
      customer_contact: offKeep,
      schedule_company: offTarget,
      schedule_contact: offKeep,
    })
  }, 120_000)
})
