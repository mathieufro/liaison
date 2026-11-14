// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who reaches the Stripe mirror once the app is registered, under the real
// liaison_rls role. Registering the app stocks the org's "Full Member" role with
// the app's member tier (reads only), so a full member reads customers and
// cannot write a refund or change a subscription, both on an org that already
// had a Full Member role before the app and on a new org.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { KERNEL_MEMBER_SCOPES } from "~/modules/permissions/default-roles"
import { insertSql } from "~/seed/factories/org/test-rows"

const FULL_MEMBER = "Full Member"
const MANIFEST = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "..",
      "bundled-apps",
      "stripe",
      "app.manifest.json",
    ),
    "utf8",
  ),
)

/** The registration-relevant part of the manifest: tables, scopes and roles. */
function stripeDescriptor() {
  return {
    name: MANIFEST.name,
    version: MANIFEST.version,
    _format: "manifest" as const,
    _bundlePath: "/apps/stripe/handlers.js",
    scopes: MANIFEST.scopes,
    roles: MANIFEST.roles,
    schema: MANIFEST.schema,
    events: MANIFEST.events,
  }
}

/** A small app that already gave the org a Full Member role before the payments app came. */
function earlierApp() {
  return {
    name: "fmearlier",
    version: "1.0.0",
    _format: "manifest" as const,
    _bundlePath: "/apps/fmearlier/handlers.js",
    schema: { items: { fields: { title: "string" } } },
    roles: { member: { description: "m", scopes: ["fmearlier:items:read"] } },
  }
}

const OLD_ORG = crypto.randomUUID()
const NEW_ORG = crypto.randomUUID()
const USERS: Record<string, string> = {
  [OLD_ORG]: crypto.randomUUID(),
  [NEW_ORG]: crypto.randomUUID(),
}

async function fullMemberScopes(orgId: string): Promise<string[]> {
  const rows = await sql<{ scope: string }[]>`
    SELECT g.scope FROM kernel.role_scope_grants g
    JOIN kernel.roles r ON r.id = g.role_id
    WHERE r.org_id = ${orgId} AND r.name = ${FULL_MEMBER} ORDER BY g.scope`
  return rows.map((r) => r.scope)
}

async function attempt(tx: Pick<RlsClient, "transaction">, statement: string): Promise<string> {
  try {
    const rows = await tx.transaction(async (sp) =>
      extractRows(await sp.execute(drizzleSql.raw(statement))),
    )
    return `rows:${rows.length}`
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } }
    return e?.cause?.code ?? e?.code ?? "error"
  }
}

async function seedMirror(orgId: string): Promise<void> {
  await sql.unsafe(
    insertSql("app_stripe.stripe_customers", {
      org_id: orgId,
      stripe_id: `cus_${orgId.slice(0, 8)}`,
      email: "billing@client.example",
      stripe_updated: "2026-11-01T00:00:00Z",
      created_at_stripe: "2026-01-01T00:00:00Z",
    }),
  )
  await sql.unsafe(
    insertSql("app_stripe.stripe_subscriptions", {
      org_id: orgId,
      stripe_id: `sub_${orgId.slice(0, 8)}`,
      customer_id: `cus_${orgId.slice(0, 8)}`,
      status: "active",
      plan_name: "Team",
      items: JSON.stringify([]),
      mrr_minor: 4900,
      currency: "eur",
      current_period_start: "2026-11-01T00:00:00Z",
      current_period_end: "2026-12-01T00:00:00Z",
      stripe_updated: "2026-11-01T00:00:00Z",
    }),
  )
}

describe("payments mirror access for a full member", () => {
  beforeAll(async () => {
    for (const id of [OLD_ORG, NEW_ORG]) {
      await sql.unsafe(
        insertSql("kernel.organizations", {
          id,
          name: "Mirror access",
          slug: `mirror-${id.slice(0, 8)}`,
        }),
      )
      await sql.unsafe(
        insertSql("kernel.users", {
          id: USERS[id],
          org_id: id,
          email: `m-${id.slice(0, 8)}@example.com`,
          name: "Member",
        }),
      )
    }
    // The old org had a Full Member role before the payments app was installed.
    await registerApps([earlierApp()] as never, OLD_ORG)
    // Full Member carries the kernel's member tier beside each app's member tier.
    expect((await fullMemberScopes(OLD_ORG)).sort()).toEqual(
      ["fmearlier:items:read", ...KERNEL_MEMBER_SCOPES].sort(),
    )
    await registerApps([stripeDescriptor()] as never, OLD_ORG)
    await registerApps([stripeDescriptor()] as never, NEW_ORG)
    for (const id of [OLD_ORG, NEW_ORG]) await seedMirror(id)
  })

  afterAll(async () => {
    resetAppRegistries()
    for (const id of [OLD_ORG, NEW_ORG]) {
      for (const t of Object.keys(MANIFEST.schema))
        await sql.unsafe(`DELETE FROM app_stripe.${t} WHERE org_id = '${id}'`)
      await sql`DELETE FROM kernel.users WHERE org_id = ${id}`
      await sql`DELETE FROM kernel.roles WHERE org_id = ${id}`
    }
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_fmearlier" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE name = 'fmearlier'`
    for (const id of [OLD_ORG, NEW_ORG])
      await sql`DELETE FROM kernel.organizations WHERE id = ${id}`
  })

  for (const [label, org] of [
    ["an org that existed before the app", () => OLD_ORG],
    ["a new org", () => NEW_ORG],
  ] as const) {
    it(`a full member reads customers and cannot refund or cancel, on ${label}`, async () => {
      const orgId = org()
      const scopes = await fullMemberScopes(orgId)
      expect(scopes).toEqual(
        expect.arrayContaining([
          "stripe:customers:read",
          "stripe:subscriptions:read",
          "stripe:invoices:read",
          "stripe:payments:read",
        ]),
      )
      for (const s of [
        "stripe:refunds:write",
        "stripe:subscriptions:write",
        "stripe:admin:connection",
        "stripe:internal",
      ]) {
        expect(scopes).not.toContain(s)
      }
      const ctx: UserContext = {
        actorType: "user",
        userId: USERS[orgId] as string,
        orgId,
        scopes,
        dimensionGrants: {},
      }
      await withRlsContext(ctx, async (tx) => {
        expect(await attempt(tx, "SELECT id FROM app_stripe.stripe_customers")).toBe("rows:1")
        expect(await attempt(tx, "SELECT id FROM app_stripe.install_metadata")).toBe("rows:0")
        // A cancellation is a subscription write: the policy filters every row out.
        expect(
          await attempt(
            tx,
            "UPDATE app_stripe.stripe_subscriptions SET status = 'canceled' RETURNING id",
          ),
        ).toBe("rows:0")
        // A refund row cannot be written at all.
        expect(
          await attempt(
            tx,
            insertSql(
              "app_stripe.stripe_refunds",
              {
                org_id: orgId,
                stripe_id: "re_x",
                payment_id: "ch_x",
                amount_minor: 100,
                currency: "eur",
                status: "pending",
                created_at_stripe: { raw: "now()" },
              },
              { returning: "id" },
            ),
          ),
        ).toBe("42501")
      })
      const [sub] = await sql<{ status: string }[]>`
        SELECT status FROM app_stripe.stripe_subscriptions WHERE org_id = ${orgId}`
      expect(sub?.status).toBe("active")
    })
  }
})
