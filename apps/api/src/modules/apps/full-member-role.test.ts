// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The auto-maintained "Full Member" composite role (migration 0006).
// App registration keeps a single system-managed role stocked with every
// installed app's standard non-admin scopes, so full members reach newly
// installed apps without a manual role edit (the 2026-07-03 calendar gap).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import mailManifest from "~/apps/mail/app.manifest.json"
import { sql } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { WebSocketManager } from "~/infra/websocket"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { extendFullMemberRole, registerApps, seedManifestRoles } from "~/modules/apps/runtime"
import { KERNEL_MEMBER_SCOPES } from "~/modules/permissions/default-roles"

const TEST_ORG = "00000000-0000-0000-0000-0000000f0001"
const FULL_MEMBER = "Full Member"

// Minimal manifest-format app carrying a member/admin role pair.
function appManifest(
  name: string,
  roles: Record<string, { description?: string; extends?: string; scopes: string[] }>,
) {
  return {
    name,
    version: "1.0.0",
    _format: "manifest" as const,
    _bundlePath: `/apps/${name}/handlers.js`,
    schema: { items: { fields: { title: "string" } } },
    tools: {
      listItems: {
        description: "List items",
        requiredScopes: [`${name}:items:read`],
        handler: "listItems",
      },
    },
    events: { emits: ["items:created"] },
    roles,
  }
}

async function scopesOf(roleName: string): Promise<string[]> {
  const rows = await sql<{ scope: string }[]>`
    SELECT g.scope FROM kernel.role_scope_grants g
    JOIN kernel.roles r ON r.id = g.role_id
    WHERE r.org_id = ${TEST_ORG} AND r.name = ${roleName}
    ORDER BY g.scope`
  return rows.map((r) => r.scope)
}

describe("Full Member composite role", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'Full Member Test Org', 'full-member-test')
      ON CONFLICT (id) DO NOTHING`
  })

  afterEach(() => resetAppRegistries())

  afterAll(async () => {
    for (const app of ["fmalpha", "fmbeta", "fmadopt", "fmtickets"]) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "app_${app}" CASCADE`)
      await sql.unsafe(`DROP SCHEMA IF EXISTS "app_${app}_untrusted" CASCADE`)
      await sql`DELETE FROM kernel.apps WHERE name = ${app}`
    }
    await sql`DELETE FROM kernel.users WHERE org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
  })

  it("creates a system-managed Full Member role with non-admin scopes, excluding the admin tier", async () => {
    await registerApps(
      [
        appManifest("fmalpha", {
          member: { description: "m", scopes: ["fmalpha:items:read", "fmalpha:items:write"] },
          admin: { description: "a", extends: "member", scopes: ["fmalpha:settings:admin"] },
        }),
      ],
      TEST_ORG,
    )

    const role = await sql<{ system_managed: boolean }[]>`
      SELECT system_managed FROM kernel.roles
      WHERE org_id = ${TEST_ORG} AND name = ${FULL_MEMBER}`
    expect(role).toHaveLength(1)
    expect(role[0].system_managed).toBe(true)

    const scopes = await scopesOf(FULL_MEMBER)
    expect(scopes).toContain("fmalpha:items:read")
    expect(scopes).toContain("fmalpha:items:write")
    // The app-admin tier is deliberately excluded.
    expect(scopes).not.toContain("fmalpha:settings:admin")
  })

  it("uses the base non-admin tier for apps without a `member` role, excluding lead-tier scopes", async () => {
    // tickets-shaped app: support (base) / support_lead (adds accounts:admin) / admin.
    const BASE_ORG = "00000000-0000-0000-0000-0000000f0004"
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${BASE_ORG}, 'Base Tier Org', 'base-tier-org') ON CONFLICT (id) DO NOTHING`
    await registerApps(
      [
        appManifest("fmtickets", {
          support: {
            description: "base",
            scopes: ["fmtickets:tickets:read", "fmtickets:tickets:write"],
          },
          support_lead: {
            description: "lead",
            extends: "support",
            scopes: ["fmtickets:accounts:admin"],
          },
          admin: {
            description: "admin",
            extends: "support_lead",
            scopes: ["fmtickets:settings:admin"],
          },
        }),
      ],
      BASE_ORG,
    )
    const rows = await sql<{ scope: string }[]>`
      SELECT g.scope FROM kernel.role_scope_grants g
      JOIN kernel.roles r ON r.id = g.role_id
      WHERE r.org_id = ${BASE_ORG} AND r.name = ${FULL_MEMBER} ORDER BY g.scope`
    const scopes = rows.map((r) => r.scope)
    expect(scopes).toContain("fmtickets:tickets:read")
    expect(scopes).toContain("fmtickets:tickets:write")
    // Base tier only — lead and admin tiers are excluded.
    expect(scopes).not.toContain("fmtickets:accounts:admin")
    expect(scopes).not.toContain("fmtickets:settings:admin")

    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_fmtickets" CASCADE`)
    await sql`DELETE FROM kernel.roles WHERE org_id = ${BASE_ORG}`
    await sql`DELETE FROM kernel.apps WHERE name = 'fmtickets'`
    await sql`DELETE FROM kernel.organizations WHERE id = ${BASE_ORG}`
  })

  it("accumulates scopes across apps (additive union)", async () => {
    await registerApps(
      [
        appManifest("fmbeta", {
          member: { description: "m", scopes: ["fmbeta:things:read"] },
          admin: { description: "a", extends: "member", scopes: ["fmbeta:things:admin"] },
        }),
      ],
      TEST_ORG,
    )
    const scopes = await scopesOf(FULL_MEMBER)
    // Alpha's scopes from the previous test persist; beta's are added.
    expect(scopes).toContain("fmalpha:items:read")
    expect(scopes).toContain("fmbeta:things:read")
    expect(scopes).not.toContain("fmbeta:things:admin")
  })

  it("adopts a hand-built same-named role in place, preserving its extra scopes", async () => {
    // Simulate the Fabrikam situation on a fresh org: an admin already hand-built
    // "Full Member" (not system-managed) with a bespoke scope, before the app registers.
    const ADOPT_ORG = "00000000-0000-0000-0000-0000000f0002"
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ADOPT_ORG}, 'Adopt Org', 'adopt-org') ON CONFLICT (id) DO NOTHING`
    await sql`
      INSERT INTO kernel.roles (id, org_id, name, description, system_managed)
      VALUES (gen_random_uuid(), ${ADOPT_ORG}, ${FULL_MEMBER}, 'hand-built umbrella', false)`
    const [{ id: umbrellaId }] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.roles WHERE org_id = ${ADOPT_ORG} AND name = ${FULL_MEMBER}`
    await sql`INSERT INTO kernel.role_scope_grants (id, role_id, scope)
      VALUES (gen_random_uuid(), ${umbrellaId}, 'legacy:custom:scope')`

    await registerApps(
      [
        appManifest("fmadopt", {
          member: { description: "m", scopes: ["fmadopt:x:read"] },
          admin: { description: "a", extends: "member", scopes: ["fmadopt:x:admin"] },
        }),
      ],
      ADOPT_ORG,
    )

    const adopted = await sql<{ system_managed: boolean }[]>`
      SELECT system_managed FROM kernel.roles
      WHERE org_id = ${ADOPT_ORG} AND name = ${FULL_MEMBER}`
    expect(adopted[0].system_managed).toBe(true)

    const scopes = await sql<{ scope: string }[]>`
      SELECT scope FROM kernel.role_scope_grants WHERE role_id = ${umbrellaId} ORDER BY scope`
    const list = scopes.map((r) => r.scope)
    expect(list).toContain("legacy:custom:scope") // preserved, not revoked
    expect(list).toContain("fmadopt:x:read") // completed with the new app
    expect(list).not.toContain("fmadopt:x:admin")

    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_fmadopt" CASCADE`)
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ADOPT_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ADOPT_ORG}`
  })

  it("bumps permission_version for assigned members only when new scopes land", async () => {
    const BUMP_ORG = "00000000-0000-0000-0000-0000000f0003"
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${BUMP_ORG}, 'Bump Org', 'bump-org') ON CONFLICT (id) DO NOTHING`

    // First registration creates the composite role.
    await registerApps(
      [appManifest("fmbeta", { member: { description: "m", scopes: ["fmbeta:things:read"] } })],
      BUMP_ORG,
    )
    const [{ id: roleId }] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.roles WHERE org_id = ${BUMP_ORG} AND name = ${FULL_MEMBER}`

    // Assign a member.
    const [{ id: userId }] = await sql<{ id: string }[]>`
      INSERT INTO kernel.users (id, org_id, email, name)
      VALUES (gen_random_uuid(), ${BUMP_ORG}, 'fm@test.local', 'FM')
      RETURNING id`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${userId}, ${roleId}, ${BUMP_ORG})`
    const before = (
      await sql<{ permission_version: number }[]>`
        SELECT permission_version FROM kernel.users WHERE id = ${userId}`
    )[0].permission_version

    // Registering a NEW app adds a new scope → member is bumped.
    await registerApps(
      [appManifest("fmalpha", { member: { description: "m", scopes: ["fmalpha:items:read"] } })],
      BUMP_ORG,
    )
    const afterNew = (
      await sql<{ permission_version: number }[]>`
        SELECT permission_version FROM kernel.users WHERE id = ${userId}`
    )[0].permission_version
    expect(afterNew).toBe(before + 1)

    // Re-registering the same app adds nothing → no further bump (idempotent).
    await registerApps(
      [appManifest("fmalpha", { member: { description: "m", scopes: ["fmalpha:items:read"] } })],
      BUMP_ORG,
    )
    const afterIdem = (
      await sql<{ permission_version: number }[]>`
        SELECT permission_version FROM kernel.users WHERE id = ${userId}`
    )[0].permission_version
    expect(afterIdem).toBe(afterNew)

    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_fmalpha" CASCADE`)
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_fmbeta" CASCADE`)
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${BUMP_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${BUMP_ORG}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${BUMP_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${BUMP_ORG}`
  })
})

// Delivery no longer depends on an in-process recording: `resolveGrantInvalidations`
// resolves a role event's CURRENT members and their thread ids from the queued
// kernel permission event plus the database, at delivery time (FX8,
// grant-invalidation.ts). So the coverage extendFullMemberRole and
// seedManifestRoles owe is that each one queues, in the SAME transaction as
// its write, the role_scope event naming its role via `data.roleId`.
describe("app registration queues the role_scope event that carries the invalidation", () => {
  const GI_ORG = "00000000-0000-0000-0000-0000000f0005"
  const FULL_MEMBER_USER = "00000000-0000-0000-0000-0000000f0051"
  const APP_ADMIN_USER = "00000000-0000-0000-0000-0000000f0052"
  const BYSTANDER = "00000000-0000-0000-0000-0000000f0053"
  const baseRoles = {
    member: { description: "m", scopes: ["fmgi:items:read"] },
    admin: { description: "a", extends: "member", scopes: ["fmgi:settings:admin"] },
  }

  async function roleIdOf(name: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.roles WHERE org_id = ${GI_ORG} AND name = ${name}`
    return row.id
  }

  async function queuedRoleScopeEvents(roleId: string): Promise<Array<Record<string, any>>> {
    const rows = await sql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${GI_ORG}
        AND payload->>'entity' = 'role_scope'
        AND payload->'data'->>'roleId' = ${roleId}
      ORDER BY created_at`
    return rows.map((r: any) => r.payload)
  }

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${GI_ORG}, 'Grant Invalidation Org', 'fm-grant-invalidation') ON CONFLICT (id) DO NOTHING`
    for (const [id, email] of [
      [FULL_MEMBER_USER, "fm-gi-full@test.local"],
      [APP_ADMIN_USER, "fm-gi-admin@test.local"],
      [BYSTANDER, "fm-gi-bystander@test.local"],
    ]) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name)
        VALUES (${id}, ${GI_ORG}, ${email}, ${email}) ON CONFLICT DO NOTHING`
    }
    await registerApps([appManifest("fmgi", baseRoles)], GI_ORG)
    resetAppRegistries()
    const fullMemberRoleId = await roleIdOf(FULL_MEMBER)
    const appAdminRoleId = await roleIdOf("fmgi.admin")
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${FULL_MEMBER_USER}, ${fullMemberRoleId}, ${GI_ORG}),
             (${APP_ADMIN_USER}, ${appAdminRoleId}, ${GI_ORG})`
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${GI_ORG}`
  })

  afterEach(() => {
    resetAppRegistries()
  })

  afterAll(async () => {
    for (const app of ["fmgi", "fmgi2"]) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "app_${app}" CASCADE`)
      await sql.unsafe(`DROP SCHEMA IF EXISTS "app_${app}_untrusted" CASCADE`)
      await sql`DELETE FROM kernel.apps WHERE name = ${app}`
    }
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${GI_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${GI_ORG}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${GI_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${GI_ORG}`
  })

  it("extendFullMemberRole queues a role_scope grant event naming the Full Member role when new scopes land", async () => {
    const fullMemberRoleId = await roleIdOf(FULL_MEMBER)
    await registerApps(
      [appManifest("fmgi2", { member: { description: "m", scopes: ["fmgi2:things:read"] } })],
      GI_ORG,
    )
    const events = await queuedRoleScopeEvents(fullMemberRoleId)
    expect(events).toHaveLength(1)
    expect(events[0].action).toBe("grant")
    expect(events[0].entityId).toBe(fullMemberRoleId)
  })

  it("seedManifestRoles queues a role_scope grant event naming the app role when a reseed adds a scope", async () => {
    const appAdminRoleId = await roleIdOf("fmgi.admin")
    await registerApps(
      [
        appManifest("fmgi", {
          ...baseRoles,
          admin: { ...baseRoles.admin, scopes: ["fmgi:settings:admin", "fmgi:reports:admin"] },
        }),
      ],
      GI_ORG,
    )
    const events = await queuedRoleScopeEvents(appAdminRoleId)
    expect(events).toHaveLength(1)
    expect(events[0].action).toBe("grant")
    expect(events[0].entityId).toBe(appAdminRoleId)
  })

  it("seedManifestRoles queues a role_scope revoke event naming the app role when a reseed drops a scope", async () => {
    const appAdminRoleId = await roleIdOf("fmgi.admin")
    await registerApps([appManifest("fmgi", baseRoles)], GI_ORG)
    const events = await queuedRoleScopeEvents(appAdminRoleId)
    expect(events).toHaveLength(1)
    expect(events[0].action).toBe("revoke")
    expect(events[0].entityId).toBe(appAdminRoleId)
  })

  it("a reseed that changes no scope queues no event", async () => {
    const appAdminRoleId = await roleIdOf("fmgi.admin")
    await registerApps([appManifest("fmgi", baseRoles)], GI_ORG)
    expect(await queuedRoleScopeEvents(appAdminRoleId)).toHaveLength(0)
  })
})

// The signal above is RECORDED inside the caller's transaction; it is only
// DELIVERED when that same transaction also queues a kernel permission event,
// because the durable `ws-fanout` consumer drains recorded changes when such
// an event arrives (grant-invalidation.test.ts). extendFullMemberRole and
// seedManifestRoles must therefore carry their own event, exactly like the
// role and user grant paths in permissions/roles.ts.
describe("extendFullMemberRole and seedManifestRoles carry their own permission event for the outbox drain", () => {
  const FX6_ORG = "00000000-0000-0000-0000-0000000f0060"
  const FULL_MEMBER_USER = "00000000-0000-0000-0000-0000000f0061"
  const FULL_MEMBER_USER_2 = "00000000-0000-0000-0000-0000000f0062"
  const APP_ADMIN_USER = "00000000-0000-0000-0000-0000000f0063"
  const BYSTANDER = "00000000-0000-0000-0000-0000000f0064"
  const APP = "fmfx6"

  interface FakeWs {
    sent: string[]
    send: (data: string) => void
    close: () => void
    readyState: number
  }
  function openWs(): FakeWs {
    const sent: string[] = []
    return {
      sent,
      send: (data: string) => {
        sent.push(data)
      },
      close: () => {},
      readyState: 1,
    }
  }
  function invalidatesOf(ws: FakeWs): Array<Record<string, unknown>> {
    return ws.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame.type === "visibility:invalidate")
  }
  // Only the handful of commands bufferAndBroadcast touches; the in-memory
  // connection backend keeps the sockets themselves local to the manager.
  const fakeRedis = {
    zadd: async () => 0,
    // The replay buffer append (websocket-replay-buffer.ts) is one Lua script.
    eval: async () => 0,
    zrangebyscore: async () => [] as string[],
    expire: async () => 1,
    incr: async () => 1,
    exists: async () => 1,
    get: async () => null,
    set: async () => "OK",
    del: async () => 0,
  }

  async function roleId(name: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.roles WHERE org_id = ${FX6_ORG} AND name = ${name}`
    return row.id
  }

  async function queuedRoleScopeEvents(forRoleId: string): Promise<Array<Record<string, any>>> {
    const rows = await sql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${FX6_ORG}
        AND payload->>'app' = 'kernel'
        AND payload->>'entity' = 'role_scope'
        AND payload->'data'->>'roleId' = ${forRoleId}
      ORDER BY created_at`
    return rows.map((r: any) => r.payload)
  }

  // `seedManifestRoles`/`extendFullMemberRole` take a bare transaction handle
  // (not an `RlsClient`), so — exactly like `setUserScopesInTx` in
  // grant-invalidation.test.ts — they must run inside a REAL transaction for
  // `tx.queueEvent` to exist and for post-commit visibility to be testable.
  async function seedManifestRolesInTx(
    orgId: string,
    appName: string,
    roles: Record<string, { description?: string; extends?: string; scopes: string[] }>,
  ): Promise<void> {
    await withSystemDb("fx6-seed-roles-test", async (tx) => {
      await seedManifestRoles(tx, orgId, appName, roles)
    })
  }

  async function extendFullMemberRoleInTx(
    orgId: string,
    roles: Record<string, { extends?: string; scopes: string[] }>,
  ): Promise<void> {
    await withSystemDb("fx6-extend-full-member-test", async (tx) => {
      await extendFullMemberRole(tx, orgId, roles)
    })
  }

  const baseRoles = {
    member: { description: "m", scopes: [`${APP}:items:read`] },
    admin: { description: "a", extends: "member", scopes: [`${APP}:settings:admin`] },
  }

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${FX6_ORG}, 'FX6 Org', 'fx6-org') ON CONFLICT (id) DO NOTHING`
    for (const [id, email] of [
      [FULL_MEMBER_USER, "fx6-full1@test.local"],
      [FULL_MEMBER_USER_2, "fx6-full2@test.local"],
      [APP_ADMIN_USER, "fx6-admin@test.local"],
      [BYSTANDER, "fx6-bystander@test.local"],
    ]) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name)
        VALUES (${id}, ${FX6_ORG}, ${email}, ${email}) ON CONFLICT DO NOTHING`
    }
    await registerApps([appManifest(APP, baseRoles)], FX6_ORG)
    resetAppRegistries()

    const fullMemberRoleId = await roleId(FULL_MEMBER)
    const appAdminRoleId = await roleId(`${APP}.admin`)
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES
      (${FULL_MEMBER_USER}, ${fullMemberRoleId}, ${FX6_ORG}),
      (${FULL_MEMBER_USER_2}, ${fullMemberRoleId}, ${FX6_ORG}),
      (${APP_ADMIN_USER}, ${appAdminRoleId}, ${FX6_ORG})`
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_${APP}" CASCADE`)
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_${APP}_untrusted" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE name = ${APP}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${FX6_ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${FX6_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${FX6_ORG}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${FX6_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${FX6_ORG}`
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${FX6_ORG}`
  })

  it("extendFullMemberRole queues a role_scope grant event when new scopes land, and the drain delivers visibility:invalidate to every holder's own sockets", async () => {
    const fullMemberRoleId = await roleId(FULL_MEMBER)
    const vm = new WebSocketManager(fakeRedis as any)
    const own1 = openWs()
    const own2 = openWs()
    const bystander = openWs()
    vm.addConnection(FULL_MEMBER_USER, own1 as any, ["kernel"], FX6_ORG)
    vm.addConnection(FULL_MEMBER_USER_2, own2 as any, ["kernel"], FX6_ORG)
    vm.addConnection(BYSTANDER, bystander as any, ["kernel"], FX6_ORG)

    await extendFullMemberRoleInTx(FX6_ORG, {
      member: { scopes: [`${APP}:items:read`, `${APP}:notes:read`] },
    })

    const events = await queuedRoleScopeEvents(fullMemberRoleId)
    expect(events).toHaveLength(1)
    expect(events[0].app).toBe("kernel")
    expect(events[0].entity).toBe("role_scope")
    expect(events[0].action).toBe("grant")
    expect(events[0].orgId).toBe(FX6_ORG)

    await vm.bufferAndBroadcast(events[0] as any)

    // Every Full Member holder's own sockets, and nowhere else.
    expect(invalidatesOf(own1)).toHaveLength(1)
    expect(invalidatesOf(own2)).toHaveLength(1)
    expect(invalidatesOf(bystander)).toHaveLength(0)
  })

  it("seedManifestRoles queues a role_scope event when a reseed changes the scope set, and the drain delivers visibility:invalidate to the role holder's own sockets", async () => {
    const appAdminRoleId = await roleId(`${APP}.admin`)
    const vm = new WebSocketManager(fakeRedis as any)
    const own = openWs()
    const bystander = openWs()
    vm.addConnection(APP_ADMIN_USER, own as any, ["kernel"], FX6_ORG)
    vm.addConnection(BYSTANDER, bystander as any, ["kernel"], FX6_ORG)

    await seedManifestRolesInTx(FX6_ORG, APP, {
      ...baseRoles,
      admin: { ...baseRoles.admin, scopes: [`${APP}:settings:admin`, `${APP}:reports:admin`] },
    })

    const events = await queuedRoleScopeEvents(appAdminRoleId)
    expect(events).toHaveLength(1)
    expect(events[0].app).toBe("kernel")
    expect(events[0].entity).toBe("role_scope")
    expect(events[0].action).toBe("grant")
    expect(events[0].orgId).toBe(FX6_ORG)

    await vm.bufferAndBroadcast(events[0] as any)

    expect(invalidatesOf(own)).toHaveLength(1)
    expect(invalidatesOf(bystander)).toHaveLength(0)
  })

  it("neither function queues an event when the scope set is unchanged", async () => {
    const fullMemberRoleId = await roleId(FULL_MEMBER)
    const appAdminRoleId = await roleId(`${APP}.admin`)

    const memberDef = {
      member: { scopes: [`${APP}:items:read`, `${APP}:widgets:read`] },
    }
    await extendFullMemberRoleInTx(FX6_ORG, memberDef) // may add scopes the first time
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${FX6_ORG}`
    await extendFullMemberRoleInTx(FX6_ORG, memberDef) // identical reseed — no-op
    expect(await queuedRoleScopeEvents(fullMemberRoleId)).toHaveLength(0)

    const adminDef = {
      ...baseRoles,
      admin: { ...baseRoles.admin, scopes: [`${APP}:settings:admin`, `${APP}:reports:admin`] },
    }
    await seedManifestRolesInTx(FX6_ORG, APP, adminDef) // may change scopes the first time
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${FX6_ORG}`
    await seedManifestRolesInTx(FX6_ORG, APP, adminDef) // identical reseed — no-op
    expect(await queuedRoleScopeEvents(appAdminRoleId)).toHaveLength(0)
  })

  it("the queued event is not visible outside the grant transaction until it commits", async () => {
    const fullMemberRoleId = await roleId(FULL_MEMBER)
    let midTx: unknown[] = []
    await withSystemDb("fx6-post-commit", async (tx) => {
      await extendFullMemberRole(tx, FX6_ORG, {
        member: {
          scopes: [`${APP}:items:read`, `${APP}:notes:read`, `${APP}:tags:read`],
        },
      })
      // A SEPARATE connection cannot see the outbox row while the write
      // transaction is still open: that is what makes the drain post-commit.
      midTx = await queuedRoleScopeEvents(fullMemberRoleId)
    })
    expect(midTx).toHaveLength(0)
    expect(await queuedRoleScopeEvents(fullMemberRoleId)).toHaveLength(1)
  })
})

// Who has opted out of mail is needed by anyone who writes to people, so mail's
// base member tier reads the opt-out list and the Full Member role inherits it,
// as registration runs it (seedManifestRoles, then extendFullMemberRole) for a
// new org and again for an existing org when the upgraded app registers. Adding
// or removing an opt-out by hand stays with mail admins.
describe("mail's member tier and the opt-out list", () => {
  const NEW_ORG = "00000000-0000-0000-0000-0000000f0070"
  const UPGRADED_ORG = "00000000-0000-0000-0000-0000000f0071"
  const mailRoles = (
    mailManifest as unknown as {
      roles: Record<string, { description?: string; extends?: string; scopes: string[] }>
    }
  ).roles

  async function registerMailRoles(orgId: string): Promise<void> {
    await withSystemDb("mail-member-tier-test", async (tx) => {
      await seedManifestRoles(tx, orgId, "mail", mailRoles)
      await extendFullMemberRole(tx, orgId, mailRoles)
    })
  }

  async function grantsOf(orgId: string, roleName: string): Promise<string[]> {
    const rows = await sql<{ scope: string }[]>`
      SELECT g.scope FROM kernel.role_scope_grants g
      JOIN kernel.roles r ON r.id = g.role_id
      WHERE r.org_id = ${orgId} AND r.name = ${roleName}
      ORDER BY g.scope`
    return rows.map((r) => r.scope)
  }

  beforeAll(async () => {
    for (const [id, slug] of [
      [NEW_ORG, "fm-mail-new"],
      [UPGRADED_ORG, "fm-mail-upgraded"],
    ]) {
      await sql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${id}, ${slug}, ${slug}) ON CONFLICT (id) DO NOTHING`
    }
  })

  afterAll(async () => {
    for (const id of [NEW_ORG, UPGRADED_ORG]) {
      await sql`DELETE FROM kernel.pending_events WHERE org_id = ${id}`
      await sql`DELETE FROM kernel.roles WHERE org_id = ${id}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${id}`
    }
  })

  it("a full member of a new org reads who opted out of mail and cannot change the list", async () => {
    await registerMailRoles(NEW_ORG)
    const fullMember = await grantsOf(NEW_ORG, FULL_MEMBER)
    expect(fullMember).toContain("mail:suppressions:read")
    expect(fullMember).not.toContain("mail:suppressions:write")
    const mailMember = await grantsOf(NEW_ORG, "mail.member")
    expect(mailMember).toEqual(["mail:suppressions:read"])
  })

  it("an org whose Full Member predates the upgrade gains the opt-out read when mail registers again, keeping its other scopes", async () => {
    await sql`
      INSERT INTO kernel.roles (id, org_id, name, description, system_managed)
      VALUES (gen_random_uuid(), ${UPGRADED_ORG}, ${FULL_MEMBER}, 'before the upgrade', true)`
    const [{ id: roleId }] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.roles WHERE org_id = ${UPGRADED_ORG} AND name = ${FULL_MEMBER}`
    await sql`INSERT INTO kernel.role_scope_grants (id, role_id, scope)
      VALUES (gen_random_uuid(), ${roleId}, 'projects:tasks:write')`

    await registerMailRoles(UPGRADED_ORG)

    const fullMember = await grantsOf(UPGRADED_ORG, FULL_MEMBER)
    // The kernel's member tier joins at the same registration.
    expect([...fullMember].sort()).toEqual(
      ["mail:suppressions:read", "projects:tasks:write", ...KERNEL_MEMBER_SCOPES].sort(),
    )
  })
})
