// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { awaitOrgApps } from "~/modules/apps/init"
import { registerKernelBulkApp } from "~/modules/apps/kernel-bulk"
import { signAccessToken } from "~/modules/auth/jwt"
import { COMPANY_RESOURCE } from "~/modules/contacts/companies"
import {
  HANDOVER_KIND,
  handleCompanyOwnershipEvent,
  UNOWNED_KIND,
} from "~/modules/contacts/company-unowned"
import { everyMemberScopeGrants } from "~/modules/permissions/permissions"
import { replaceGrants } from "~/modules/sharing/service"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-00000000abc1"
const ADMIN = "00000000-0000-4000-8000-00000000abc2"
const TARGET_A = "00000000-0000-4000-8000-00000000abc3"
const TARGET_B = "00000000-0000-4000-8000-00000000abc4"

function uuid(seed: number): string {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`
}

let token: string

beforeAll(async () => {
  await acquireTestLock()
  // Clean any stray bulk + idempotency cache from previous runs
  await clearRedisPatterns([`bulk:${ORG}:*`, `app_idem:${ORG}:*`])
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Kernel Bulk Org', 'kernel-bulk-org')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES (${ADMIN}, ${ORG}, 'kb-admin@test.com', 'KB Admin', 'active')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES (${TARGET_A}, ${ORG}, 'kb-a@test.com', 'Target A', 'active')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES (${TARGET_B}, ${ORG}, 'kb-b@test.com', 'Target B', 'active')`
  // Deactivating someone needs every scope they hold (assertActorOutranksTarget), and every
  // active member holds the installed apps' every-member scopes (once the org is set up): so
  // does a real admin's token.
  await awaitOrgApps(ORG)
  const everyMember = await withPrivilegedDb(ORG, "kernel-bulk-test-scopes", (tx) =>
    everyMemberScopeGrants(tx, ADMIN, ORG),
  )
  token = await signAccessToken(
    {
      userId: ADMIN,
      orgId: ORG,
      name: "KB Admin",
      authVersion: 1,
      permissionVersion: 1,
      scopes: ["kernel:users:admin", ...everyMember.map((g) => g.scope)],
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
  registerKernelBulkApp(ORG)
})

afterAll(async () => {
  toolRegistry.deleteByPrefix([ORG, "kernel"])
  manifestRegistry.delete([ORG, "kernel"])
  await clearRedisPatterns([`bulk:${ORG}:*`])
  await releaseTestLock()
})

describe("kernel-bulk runtime", () => {
  it("registers kernel.deactivateUsers manifest entry", () => {
    const manifest = manifestRegistry.get([ORG, "kernel"])
    expect(manifest?.bulk?.deactivateUsers).toBeTruthy()
    expect(manifest!.bulk!.deactivateUsers.underlyingTool).toBe("deactivateUser")
    expect(manifest!.bulk!.deactivateUsers.dispatchMode).toBe("perItem")
  })

  it("registers underlying kernel:deactivateUser tool", () => {
    const tool = toolRegistry.get([ORG, "kernel", "deactivateUser"])
    expect(tool).toBeTruthy()
    expect(tool!.requiredScopes).toEqual(["kernel:users:admin"])
  })

  it("registers bulkDeactivateUsers agent tool with bulkMeta", () => {
    const tool = toolRegistry.get([ORG, "kernel", "bulkDeactivateUsers"])
    expect(tool).toBeTruthy()
    expect((tool as any).bulkMeta).toEqual({ app: "kernel", action: "deactivateUsers" })
  })

  it("POST /api/apps/kernel/bulk/deactivateUsers deactivates each user", async () => {
    const res = await app.request("/api/apps/kernel/bulk/deactivateUsers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ids: [TARGET_A, TARGET_B],
        params: {},
        idempotencyKey: uuid(100),
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { total: number; succeeded: number; failed: number }
    }
    expect(body.data.total).toBe(2)
    expect(body.data.succeeded).toBe(2)
    expect(body.data.failed).toBe(0)
    const [a] = await sql`SELECT status FROM kernel.users WHERE id = ${TARGET_A}`
    const [b] = await sql`SELECT status FROM kernel.users WHERE id = ${TARGET_B}`
    expect(a.status).toBe("deactivated")
    expect(b.status).toBe("deactivated")
  })

  it("self-deactivation surfaces as per-item failure (no crash)", async () => {
    const res = await app.request("/api/apps/kernel/bulk/deactivateUsers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ids: [ADMIN],
        params: {},
        idempotencyKey: uuid(200),
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { total: number; succeeded: number; failed: number; errors: Array<{ code: string }> }
    }
    expect(body.data.failed).toBe(1)
    expect(body.data.succeeded).toBe(0)
  })
})

describe("deactivating someone who manages companies", () => {
  const people = {
    leaver: uuid(0xa01),
    taker: uuid(0xa02),
    gone: uuid(0xa03),
    bulkA: uuid(0xa04),
    bulkB: uuid(0xa05),
    nullLeaver: uuid(0xa06),
    previous: uuid(0xa07),
    creator: uuid(0xa08),
  }

  beforeAll(async () => {
    for (const [key, id] of Object.entries(people)) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status)
                VALUES (${id}, ${ORG}, ${`kb-${key}@test.com`}, ${`Person ${key}`}, 'active')`
    }
    await sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${people.gone}`
    // The admin sees the unowned rows: they can see who left and give companies to someone.
    for (const scope of ["kernel:users:admin", "kernel:companies:write"]) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${ADMIN}, ${ORG}, ${scope})`
    }
  })

  async function company(
    name: string,
    owner: string | null,
    extra: { orgAccess?: "none" | "editor"; createdBy?: string } = {},
  ): Promise<string> {
    const [row] = await sql`
      INSERT INTO kernel.companies (org_id, handle, name, owner_user_id, org_access, created_by)
      VALUES (${ORG}, ${`co-${crypto.randomUUID().slice(0, 8)}`}, ${name}, ${owner},
              ${extra.orgAccess ?? "editor"}, ${extra.createdBy ?? ADMIN})
      RETURNING id`
    return row.id as string
  }

  async function deactivate(params: Record<string, unknown>) {
    const res = await app.request("/api/apps/kernel/tools/deactivateUser", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(params),
    })
    return { status: res.status, body: (await res.json()) as any }
  }

  const statusOf = async (id: string) =>
    ((await sql`SELECT status FROM kernel.users WHERE id = ${id}`)[0] as { status: string }).status
  const ownerOf = async (id: string) =>
    (
      (await sql`SELECT owner_user_id FROM kernel.companies WHERE id = ${id}`)[0] as {
        owner_user_id: string | null
      }
    ).owner_user_id

  async function unownedRows(leftUserId: string) {
    return sql`
      SELECT user_id, summary, metadata FROM kernel.attention_events
      WHERE org_id = ${ORG} AND kind = ${UNOWNED_KIND} AND entity_id = ${leftUserId}
        AND read_at IS NULL`
  }

  it("deactivating someone who manages companies without saying to whom is refused with the count", async () => {
    const a = await company("Maison Arlon", people.leaver)
    const b = await company("Studio Brume", people.leaver)
    const res = await deactivate({ userId: people.leaver })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.body.error.code).toBe("accounts_to_required")
    expect(res.body.error.message).toContain("manages 2 companies")
    expect(res.body.error.message).toContain("Nothing was changed")
    expect(await statusOf(people.leaver)).toBe("active")
    expect(await ownerOf(a)).toBe(people.leaver)
    expect(await ownerOf(b)).toBe(people.leaver)
  })

  it("someone with more authority than the actor is refused before any of their companies is named", async () => {
    const senior = uuid(0xa09)
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status)
              VALUES (${senior}, ${ORG}, 'kb-senior@test.com', 'Person senior', 'active')`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${senior}, ${ORG}, '*')`
    const held = await company("Holding Secrète", senior, { orgAccess: "none" })
    try {
      const res = await deactivate({ userId: senior })
      expect(res.body.error.code).toBe("forbidden")
      expect(JSON.stringify(res.body)).not.toContain("Holding Secrète")
      expect(await statusOf(senior)).toBe("active")
    } finally {
      // A second administrator would join every later test's audience.
      await sql`DELETE FROM kernel.companies WHERE id = ${held}`
      await sql`DELETE FROM kernel.user_scope_grants WHERE user_id = ${senior}`
      await sql`DELETE FROM kernel.users WHERE id = ${senior}`
    }
  })

  it("a person id moves them under the same checks", async () => {
    // Someone who is not an active member cannot take them: refused, nothing changes.
    const refused = await deactivate({ userId: people.leaver, accountsTo: people.gone })
    expect(refused.body.error.code).toBe("manager_inactive")
    expect(await statusOf(people.leaver)).toBe("active")

    // A company the new manager cannot read stays without one, named with why.
    const hidden = await company("Cabinet Privé", people.leaver, { orgAccess: "none" })
    const res = await deactivate({ userId: people.leaver, accountsTo: people.taker })
    expect(res.status).toBe(200)
    expect(await statusOf(people.leaver)).toBe("deactivated")
    const moved = res.body.data.companies.moved.map((c: { name: string }) => c.name).sort()
    expect(moved).toEqual(["Maison Arlon", "Studio Brume"])
    expect(res.body.data.companies.skipped.map((c: { id: string }) => c.id)).toEqual([hidden])
    expect(await ownerOf(hidden)).toBeNull()
    expect(res.body.data.message).toContain("moved to Person taker")
    expect(res.body.data.message).toContain("Share the company with them")
  })

  it("null leaves them unowned", async () => {
    const a = await company("Studio Cèdre", people.nullLeaver)
    const res = await deactivate({ userId: people.nullLeaver, accountsTo: null })
    expect(res.status).toBe(200)
    expect(await statusOf(people.nullLeaver)).toBe("deactivated")
    expect(await ownerOf(a)).toBeNull()
    expect(res.body.data.companies.withoutManager.map((c: { id: string }) => c.id)).toEqual([a])
  })

  it("bulk deactivation carries the answer to each person", async () => {
    const a = await company("Bulk Alpha", people.bulkA)
    const b = await company("Bulk Beta", people.bulkB)
    const res = await app.request("/api/apps/kernel/bulk/deactivateUsers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ids: [people.bulkA, people.bulkB],
        params: { accountsTo: people.taker },
        idempotencyKey: uuid(0xa100),
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { succeeded: number } }
    expect(body.data.succeeded).toBe(2)
    expect(await ownerOf(a)).toBe(people.taker)
    expect(await ownerOf(b)).toBe(people.taker)
  })

  it("one unowned row per person left, gone at zero and on reactivation, never for a company that never had one", async () => {
    const leaver = uuid(0xa20)
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status)
              VALUES (${leaver}, ${ORG}, 'kb-lea@test.com', 'Léa Fontaine', 'active')`
    const first = await company("Unowned One", leaver)
    const second = await company("Unowned Two", leaver)
    const neverManaged = await company("Never Managed", null)
    const res = await deactivate({ userId: leaver, accountsTo: null })
    expect(res.status).toBe(200)

    let rows = await unownedRows(leaver)
    expect(rows.map((r) => r.user_id)).toEqual([ADMIN])
    expect(rows[0]!.summary).toBe("2 companies have no account manager since Léa Fontaine left")
    expect((rows[0]!.metadata as { companyIds: string[] }).companyIds.sort()).toEqual(
      [first, second].sort(),
    )
    expect(JSON.stringify(rows)).not.toContain(neverManaged)

    // One company gets a manager: the row counts one; the other: the row is gone.
    const handOver = async (companyId: string) => {
      await sql`UPDATE kernel.companies SET owner_user_id = ${people.taker} WHERE id = ${companyId}`
      await handleCompanyOwnershipEvent({
        app: "kernel",
        entity: "company",
        action: "update",
        orgId: ORG,
        actorId: ADMIN,
        actorType: "user",
        entityId: companyId,
        data: { id: companyId, name: "x", ownerUserId: people.taker, previousOwnerUserId: null },
        timestamp: new Date().toISOString(),
      } as never)
    }
    await handOver(first)
    rows = await unownedRows(leaver)
    expect(rows[0]!.summary).toBe("1 company has no account manager since Léa Fontaine left")
    await handOver(second)
    expect(await unownedRows(leaver)).toHaveLength(0)

    // Another departure, then the person comes back: the row goes.
    const back = uuid(0xa21)
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status)
              VALUES (${back}, ${ORG}, 'kb-back@test.com', 'Back Again', 'active')`
    await company("Comes Back Co", back)
    await deactivate({ userId: back, accountsTo: null })
    expect(await unownedRows(back)).toHaveLength(1)
    const re = await app.request(`/api/admin/users/${back}/reactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}",
    })
    expect(re.status).toBe(200)
    await handleCompanyOwnershipEvent({
      app: "kernel",
      entity: "user",
      action: "reactivate",
      orgId: ORG,
      actorId: ADMIN,
      actorType: "user",
      entityId: back,
      timestamp: new Date().toISOString(),
    } as never)
    expect(await unownedRows(back)).toHaveLength(0)
  })

  it("the previous manager is told who changed it", async () => {
    const a = await company("Handed Alpha", people.taker)
    const b = await company("Handed Beta", people.taker)
    const event = (companyId: string, name: string, actorId: string) =>
      ({
        app: "kernel",
        entity: "company",
        action: "update",
        orgId: ORG,
        actorId,
        actorType: "user",
        entityId: companyId,
        data: {
          id: companyId,
          name,
          ownerUserId: people.previous,
          previousOwnerUserId: people.taker,
        },
        timestamp: new Date().toISOString(),
      }) as never
    // Handled in the other order than the names read: the line still names them by name.
    await handleCompanyOwnershipEvent(event(b, "Handed Beta", ADMIN))
    await handleCompanyOwnershipEvent(event(a, "Handed Alpha", ADMIN))
    const told = await sql`
      SELECT summary, metadata FROM kernel.attention_events
      WHERE org_id = ${ORG} AND user_id = ${people.taker} AND kind = ${HANDOVER_KIND}
        AND read_at IS NULL`
    expect(told).toHaveLength(1)
    expect(told[0]!.summary).toBe("KB Admin gave Handed Alpha and Handed Beta to Person previous")
    expect((told[0]!.metadata as { changedBy: { id: string } }).changedBy.id).toBe(ADMIN)

    // Giving away your own companies tells nobody.
    const own = await company("Own Gift", people.previous)
    await handleCompanyOwnershipEvent({
      ...(event(own, "Own Gift", people.previous) as object),
      data: {
        id: own,
        name: "Own Gift",
        ownerUserId: people.taker,
        previousOwnerUserId: people.previous,
      },
    } as never)
    const self = await sql`
      SELECT 1 FROM kernel.attention_events
      WHERE org_id = ${ORG} AND user_id = ${people.previous} AND kind = ${HANDOVER_KIND}`
    expect(self).toHaveLength(0)
  })

  it("a departed creator's private company can be re-shared by an admin", async () => {
    const privateCo = await company("Creator's Private", null, {
      orgAccess: "none",
      createdBy: people.creator,
    })
    await deactivate({ userId: people.creator })
    expect(await statusOf(people.creator)).toBe("deactivated")
    const contactsAdmin = {
      actorType: "user" as const,
      userId: ADMIN,
      orgId: ORG,
      scopes: ["kernel:contacts:admin", "kernel:companies:write", "kernel:companies:read"],
      dimensionGrants: {},
    }
    const can = await withRlsContext(contactsAdmin, async (tx) => {
      const [row] = extractRows<{ ok: boolean }>(
        await tx.execute(
          drizzleSql`SELECT kernel.can_manage_company_sharing(${privateCo}::uuid) AS ok`,
        ),
      )
      // Re-share it with someone, through the sharing service the company's page uses.
      await replaceGrants(tx, { orgId: ORG, userId: ADMIN }, COMPANY_RESOURCE, privateCo, {
        users: [{ userId: people.taker, role: "editor" }],
      })
      return row?.ok
    })
    expect(can).toBe(true)
    const grants = await sql`
      SELECT grantee, role FROM kernel.resource_grants
      WHERE resource_type = ${COMPANY_RESOURCE} AND resource_id = ${privateCo}`
    expect(grants.map((g) => [g.grantee, g.role])).toEqual([[people.taker, "editor"]])
  })
})
