// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-org caps (S4.1-S4.4, S4.6, S4.7; amendments A15, A16, A19, A23-A25):
// seats and mailboxes refused at their cap under the org lock, storage read
// from caps, the operator-only surfaces, the usage API and the notices.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { orgCapsSchema } from "@liaison/shared"
import { app } from "~/app"
import { limitsSchema } from "~/cli/config/schema"
import { runOrgCapsCli } from "~/cli/org-caps"
import { limitsProvisioner } from "~/cli/provisioners/limits"
import { buildProvisionContext } from "~/cli/provisioners/types"
import { sql } from "~/db"
import { createPool } from "~/db/connection"
import {
  type PrivilegedAcquisition,
  PrivilegedDbTestAccess,
  withPrivilegedDb,
  withSystemDb,
} from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { KERNEL_DECLARED_EMITS } from "~/infra/events/event-bus"
import { generateToken, hashToken } from "~/lib/crypto"
import { _setEdition } from "~/lib/edition"
import { redis } from "~/lib/redis"
import { registerConfigTools } from "~/modules/agent/tools/config-tools"
import {
  connectionConfigRegistry,
  declaredEmits,
  oauthClientResolverRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { upsertConnectionOAuthClient } from "~/modules/apps/connections/oauth-client-provisioning"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { currentPlanUsage } from "~/modules/billing-managed/usage"
import { loadOrgSettings, orgQuotaBytes, wouldExceedOrgQuota } from "~/modules/files/service"
import {
  CapLimitError,
  capLevelsSettled,
  countSeats,
  evaluateCapLevel,
  getOrgUsage,
  normalizeCaps,
  readOrgCaps,
  setOrgCaps,
} from "~/modules/org/caps"
import { isConfigToolSection } from "~/modules/provisioning/config-tool-input"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { createExternalUser } from "~/modules/users/external-user"
import { createInvitation } from "~/modules/users/invites"
import { reactivateUser } from "~/modules/users/service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

async function setCaps(orgId: string, caps: Record<string, unknown>): Promise<void> {
  await sql`UPDATE kernel.organizations SET caps = ${JSON.stringify(caps)}::jsonb WHERE id = ${orgId}`
}

async function invite(orgId: string, email: string): Promise<string> {
  const [role] = await sql`SELECT id FROM kernel.roles WHERE org_id = ${orgId} AND name = 'member'`
  const [admin] = await sql`SELECT id FROM kernel.users WHERE org_id = ${orgId} LIMIT 1`
  const token = generateToken()
  await sql`
    INSERT INTO kernel.invitations (org_id, email, role_id, token_hash, invited_by, expires_at)
    VALUES (${orgId}, ${email}, ${role.id}, ${hashToken(token)}, ${admin.id}, now() + interval '7 days')
  `
  return token
}

function accept(token: string, name: string) {
  return app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inviteToken: token, name }),
  })
}

/** The cap refusal a call ends with; any other outcome fails the test. */
async function capRefusal(call: Promise<unknown>): Promise<CapLimitError> {
  const err = await call.then(
    () => null,
    (e: unknown) => e,
  )
  if (!(err instanceof CapLimitError)) throw new Error(`expected a cap refusal, got ${String(err)}`)
  return err
}

async function activeSeats(orgId: string): Promise<number> {
  return withSystemDb("t", (db) => countSeats(db, orgId))
}

beforeAll(async () => {
  await acquireTestLock()
  await createTestOrg()
})
afterAll(async () => {
  await releaseTestLock()
})

describe("seats", () => {
  it("accept at the limit is refused with 409 SEAT_LIMIT_REACHED and {limit, used}; the invite stays usable", async () => {
    const { orgId } = await minimal.secondOrg()
    const used = await activeSeats(orgId)
    await setCaps(orgId, { seats: used })
    const token = await invite(orgId, "full@caps.test")
    const res = await accept(token, "Full")
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details: unknown } }
    expect(body.error.code).toBe("SEAT_LIMIT_REACHED")
    expect(body.error.details).toEqual({ limit: used, used })
    const [inv] =
      await sql`SELECT accepted_at FROM kernel.invitations WHERE org_id = ${orgId} AND email = 'full@caps.test'`
    expect(inv.accepted_at).toBeNull()
    // Raised by the operator: the same invite now works.
    await setCaps(orgId, { seats: used + 1 })
    expect((await accept(token, "Full")).status).toBe(200)
  })

  it("two concurrent accepts at limit-1 → exactly one seat", async () => {
    const { orgId } = await minimal.secondOrg()
    const used = await activeSeats(orgId)
    await setCaps(orgId, { seats: used + 1 })
    const [t1, t2] = [await invite(orgId, "r1@caps.test"), await invite(orgId, "r2@caps.test")]
    const statuses = (await Promise.all([accept(t1, "R1"), accept(t2, "R2")]))
      .map((r) => r.status)
      .sort()
    expect(statuses).toEqual([200, 409])
    expect(await activeSeats(orgId)).toBe(used + 1)
  })

  it("agents and deactivated people take no seat", async () => {
    const { orgId } = await minimal.secondOrg()
    // An accepted invite creates the person and their personal agent
    // (kernel.agents); the agent takes no seat.
    expect((await accept(await invite(orgId, "ag@caps.test"), "Ag")).status).toBe(200)
    const [{ n: agents }] =
      await sql`SELECT count(*)::int AS n FROM kernel.agents WHERE org_id = ${orgId}`
    expect(agents).toBeGreaterThan(0)
    const [member] =
      await sql`SELECT id FROM kernel.users WHERE org_id = ${orgId} AND email = 'ag@caps.test'`
    expect(await activeSeats(orgId)).toBe(2)
    await sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${member.id}`
    expect(await activeSeats(orgId)).toBe(1)
  })

  it("a client's portal account takes no seat, and is added at a full cap", async () => {
    const { orgId } = await minimal.secondOrg()
    const used = await activeSeats(orgId)
    await setCaps(orgId, { seats: used })
    const email = `client-${crypto.randomUUID().slice(0, 8)}@caps.test`
    const created = await withPrivilegedDb(orgId, "caps-test-portal-account", (tx) =>
      createExternalUser(tx, { orgId, companyId: crypto.randomUUID(), email, name: "Client" }),
    )
    if (!created.ok) throw new Error(created.code)
    await sql`UPDATE kernel.users SET status = 'active' WHERE id = ${created.userId}`
    expect(await activeSeats(orgId)).toBe(used)
    // The cap still refuses the next member.
    const res = await accept(await invite(orgId, "after-client@caps.test"), "After")
    expect(res.status).toBe(409)
  })

  it("reactivate at the limit → CapLimitError (409); under it, reactivated", async () => {
    const { orgId, adminUserId } = await minimal.secondOrg()
    const member = await minimal.person(orgId)
    await sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${member.id}`
    await setCaps(orgId, { seats: 1 })
    const run = () =>
      withPrivilegedDb(orgId, "t", (tx) =>
        reactivateUser(tx, {
          targetId: member.id,
          actorId: adminUserId,
          orgId,
          actorScopes: ["*"],
        }),
      )
    const refused = await run().catch((e) => e)
    expect(refused).toBeInstanceOf(CapLimitError)
    expect(refused.status).toBe(409)
    expect(refused.code).toBe("SEAT_LIMIT_REACHED")
    await setCaps(orgId, { seats: 2 })
    expect(await run()).not.toBeNull()
  })

  it("the route answers 409 SEAT_LIMIT_REACHED on reactivate at the limit", async () => {
    const { orgId, adminUserId } = await minimal.secondOrg()
    const member = await minimal.person(orgId)
    await sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${member.id}`
    await setCaps(orgId, { seats: 1 })
    const res = await app.request(`/api/admin/users/${member.id}/reactivate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await minimal.token(adminUserId)}` },
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "SEAT_LIMIT_REACHED",
    )
  })

  it("provisioning ensureUser and the invite form are refused at the limit", async () => {
    const { orgId, adminUserId } = await minimal.secondOrg()
    await setCaps(orgId, { seats: 1 })
    const created = await ensureUser({
      orgId,
      email: "prov@caps.test",
      name: "Prov",
      role: "member",
      allowPasswordless: true,
    }).catch((e) => e)
    expect(created).toBeInstanceOf(CapLimitError)
    const invited = await withPrivilegedDb(orgId, "t", (tx) =>
      createInvitation(tx as never, {
        orgId,
        email: "soft@caps.test",
        roleName: "member",
        invitedBy: adminUserId,
        actorScopes: ["*"],
        actorDimensionGrants: { "*": ["*"] },
      }),
    ).catch((e) => e)
    expect(invited).toBeInstanceOf(CapLimitError)
    // An existing person re-ensured takes no new seat and passes.
    const [admin] = await sql`SELECT email FROM kernel.users WHERE id = ${adminUserId}`
    const again = await ensureUser({ orgId, email: admin.email, name: "A", role: "member" })
    expect(again.created).toBe(false)
  })
})

describe("mailboxes", () => {
  async function connectImap(orgId: string, userId: string, address: string) {
    return withPrivilegedDb(orgId, "t", (tx) =>
      createCredentialConnection(tx, orgId, userId, "mail", "imap", {
        identifier: address,
        credentials: { username: address, password: "x" },
        displayName: address,
      }),
    )
  }

  it("connect at the limit → 409 MAILBOX_LIMIT_REACHED; a reconnect of a connected mailbox is allowed", async () => {
    const { orgId, adminUserId } = await minimal.secondOrg()
    const member = await minimal.person(orgId)
    await setCaps(orgId, { mailboxes: 1 })
    await connectImap(orgId, adminUserId, "a@caps.test")
    const refused = await connectImap(orgId, member.id, "b@caps.test").catch((e) => e)
    expect(refused).toBeInstanceOf(CapLimitError)
    expect(refused.code).toBe("MAILBOX_LIMIT_REACHED")
    expect(refused.details).toEqual({ limit: 1, used: 1 })
    // Re-entering the credentials of the connected mailbox is an update.
    await connectImap(orgId, adminUserId, "a@caps.test")
    expect((await getOrgUsage(orgId)).mailboxes).toEqual({ used: 1, limit: 1 })
  })

  it("two concurrent connects at limit-1 → exactly one", async () => {
    const { orgId } = await minimal.secondOrg()
    const [u1, u2] = [await minimal.person(orgId), await minimal.person(orgId)]
    await setCaps(orgId, { mailboxes: 1 })
    const results = await Promise.allSettled([
      connectImap(orgId, u1.id, "c1@caps.test"),
      connectImap(orgId, u2.id, "c2@caps.test"),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(CapLimitError)
    expect((await getOrgUsage(orgId)).mailboxes.used).toBe(1)
  })
})

describe("mailboxes in the managed edition: a plan never refuses one", () => {
  async function connect(
    orgId: string,
    userId: string,
    app: "mail" | "tickets",
    address: string,
    ownerType: "org" | "user",
  ): Promise<unknown> {
    return withPrivilegedDb(orgId, "t", (tx) =>
      createCredentialConnection(tx, orgId, userId, app, "imap", {
        identifier: address,
        credentials: { username: address, password: "x" },
        displayName: address,
        ownerType,
      }),
    )
  }

  it("org mailboxes pass even when an older push left a mailbox cap in the caps", async () => {
    const { orgId, adminUserId } = await minimal.secondOrg()
    await setCaps(orgId, { mailboxes: 1 })
    _setEdition("managed")
    try {
      await connect(orgId, adminUserId, "tickets", "support@managed-caps.test", "org")
      await connect(orgId, adminUserId, "mail", "sales@managed-caps.test", "org")
      expect(Object.keys(await currentPlanUsage(orgId)).sort()).toEqual([
        "customApps",
        "seats",
        "storageBytes",
      ])
    } finally {
      _setEdition(null)
    }
  })

  it("a member may connect more than one personal mailbox", async () => {
    const { orgId } = await minimal.secondOrg()
    const member = await minimal.person(orgId)
    _setEdition("managed")
    try {
      await connect(orgId, member.id, "mail", "first@managed-caps.test", "user")
      await connect(orgId, member.id, "tickets", "second@managed-caps.test", "user")
    } finally {
      _setEdition(null)
    }
  })

  it("self-hosted keeps the operator's cap, personal mailboxes included", async () => {
    const { orgId, adminUserId } = await minimal.secondOrg()
    const member = await minimal.person(orgId)
    await setCaps(orgId, { mailboxes: 1 })
    await connect(orgId, member.id, "mail", "member@self-hosted-caps.test", "user")
    const refused = await capRefusal(
      connect(orgId, adminUserId, "mail", "sales@self-hosted-caps.test", "org"),
    )
    expect(refused).toBeInstanceOf(CapLimitError)
    expect(refused.code).toBe("MAILBOX_LIMIT_REACHED")
    expect(refused.message).toContain("runs the server")
  })
})

describe("mailboxes: the OAuth connect and a disconnected mailbox coming back", () => {
  function unsignedJwt(payload: Record<string, unknown>): string {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
    return `${enc({ alg: "none", typ: "JWT" })}.${enc(payload)}.sig`
  }
  let nextEmail = ""
  let tokenServer: ReturnType<typeof Bun.serve> | null = null
  let tokenUrl = ""
  beforeAll(() => {
    tokenServer = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          token_type: "bearer",
          id_token: unsignedJwt({ email: nextEmail }),
        }),
    })
    tokenUrl = `http://127.0.0.1:${tokenServer.port}/token`
  })
  afterAll(() => {
    tokenServer?.stop(true)
  })

  /** A Gmail connect through the real callback route; answers its redirect. */
  async function connectGmail(orgId: string, userId: string, email: string): Promise<URL> {
    connectionConfigRegistry.set([orgId, "mail", "gmail"], {
      type: "oauth2",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl,
      scopes: ["openid", "email"],
      allowedDomains: [],
    })
    // The org's own client (below) decides, not Mail's resolver, which reads
    // the workspace's Gmail switch.
    oauthClientResolverRegistry.set([orgId, "mail", "gmail"], async () => null)
    await upsertConnectionOAuthClient({
      orgId,
      appName: "mail",
      connectionName: "gmail",
      clientId: "caps-test.apps.googleusercontent.com",
      clientSecret: "caps-test-secret",
    })
    nextEmail = email
    const state = crypto.randomUUID()
    await redis.set(
      `oauth:state:${state}`,
      JSON.stringify({
        orgId,
        userId,
        appName: "mail",
        connectionName: "gmail",
        codeVerifier: "verifier",
        tokenUrl,
        ownerType: "user",
        ownerId: userId,
      }),
      "EX",
      900,
    )
    const res = await app.request(
      `/api/connections/callback?code=code&state=${encodeURIComponent(state)}`,
    )
    if (res.status !== 302) throw new Error(`callback ${res.status}: ${await res.text()}`)
    return new URL(res.headers.get("location") ?? "", "http://x")
  }

  async function connectImap(orgId: string, userId: string, address: string) {
    return withPrivilegedDb(orgId, "t", (tx) =>
      createCredentialConnection(tx, orgId, userId, "mail", "imap", {
        identifier: address,
        credentials: { username: address, password: "x" },
        displayName: address,
      }),
    )
  }

  it("a Gmail connect at the limit goes back with oauth_error=MAILBOX_LIMIT_REACHED; a connected address still connects", async () => {
    const { orgId, adminUserId } = await minimal.secondOrg()
    await setCaps(orgId, { mailboxes: 1 })
    await connectImap(orgId, adminUserId, "first@caps.test")
    const refused = await connectGmail(orgId, adminUserId, "second@caps.test")
    expect(refused.searchParams.get("oauth_error")).toBe("MAILBOX_LIMIT_REACHED")
    expect((await getOrgUsage(orgId)).mailboxes).toEqual({ used: 1, limit: 1 })
    // The address already connected (over IMAP) adds nothing: Gmail connects it.
    const ok = await connectGmail(orgId, adminUserId, "first@caps.test")
    expect(ok.searchParams.get("oauth_error")).toBeNull()
    const [row] = await sql`
      SELECT count(*)::int AS n FROM kernel.connected_accounts
      WHERE org_id = ${orgId} AND connection_name = 'gmail' AND status = 'active'`
    expect(row?.n).toBe(1)
  })

  it("a disconnected mailbox saved again counts as new: refused at the limit", async () => {
    const { orgId, adminUserId } = await minimal.secondOrg()
    const member = await minimal.person(orgId)
    await setCaps(orgId, { mailboxes: 1 })
    await connectImap(orgId, adminUserId, "gone@caps.test")
    await sql`UPDATE kernel.connected_accounts SET status = 'disconnected'
      WHERE org_id = ${orgId} AND identifier = 'gone@caps.test'`
    await connectImap(orgId, member.id, "now@caps.test")
    const refused = await connectImap(orgId, adminUserId, "gone@caps.test").catch((e) => e)
    expect(refused).toBeInstanceOf(CapLimitError)
    expect(refused.details).toEqual({ limit: 1, used: 1 })
    expect((await getOrgUsage(orgId)).mailboxes.used).toBe(1)
  })
})

describe("the cap check never takes a second pool connection under the lock", () => {
  const small = createPool(2)
  afterAll(async () => {
    PrivilegedDbTestAccess.usePool(null)
    await small.client.end()
  })

  it("a burst of connects and sign-ups twice the privileged pool's size completes, with no nested acquisition", async () => {
    const { orgId, adminUserId } = await minimal.secondOrg()
    // Four people, each connecting a personal mailbox in their own RLS
    // transaction (the route's path), while the privileged pool has 2 slots.
    const owners = [
      await minimal.person(orgId),
      await minimal.person(orgId),
      await minimal.person(orgId),
      await minimal.person(orgId),
    ]
    await setCaps(orgId, { mailboxes: 2, seats: 7 })
    PrivilegedDbTestAccess.usePool({ db: small.db, acquireTimeoutMs: 3_000 })
    PrivilegedDbTestAccess.record()
    let recorded: PrivilegedAcquisition[] = []
    let mail: PromiseSettledResult<unknown>[] = []
    let orgMail: PromiseSettledResult<unknown>[] = []
    let people: PromiseSettledResult<unknown>[] = []
    try {
      mail = await Promise.allSettled(
        owners.map((owner, i) =>
          withRlsContext(
            { actorType: "user", userId: owner.id, orgId, scopes: ["*"], dimensionGrants: {} },
            (tx) =>
              createCredentialConnection(tx, orgId, owner.id, "mail", "imap", {
                identifier: `burst${i}@caps.test`,
                credentials: { username: `burst${i}@caps.test`, password: "x" },
              }),
          ),
        ),
      )
      // And four org mailboxes saved by the admin, each on a privileged slot.
      orgMail = await Promise.allSettled(
        [1, 2, 3, 4].map((i) =>
          withPrivilegedDb(orgId, "t-burst-org-connect", (tx) =>
            createCredentialConnection(tx, orgId, adminUserId, "tickets", "imap", {
              identifier: `org-burst${i}`,
              credentials: { username: `org-burst${i}@caps.test`, password: "x" },
              ownerType: "org",
            }),
          ),
        ),
      )
      people = await Promise.allSettled(
        [1, 2, 3, 4].map((i) =>
          ensureUser({
            orgId,
            email: `burst${i}@caps.test`,
            name: `B${i}`,
            role: "member",
            allowPasswordless: true,
          }),
        ),
      )
    } finally {
      recorded = PrivilegedDbTestAccess.recorded()
      PrivilegedDbTestAccess.usePool(null)
    }
    const reasons = (rs: PromiseSettledResult<unknown>[]) =>
      rs.map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as Error).constructor.name)).sort()
    expect(reasons(mail)).toEqual(["CapLimitError", "CapLimitError", "ok", "ok"])
    // The cap is full: every org mailbox is refused too, none stalls.
    expect(reasons(orgMail)).toEqual(Array(4).fill("CapLimitError"))
    expect(reasons(people)).toEqual(["CapLimitError", "CapLimitError", "ok", "ok"])
    expect(recorded.filter((a) => a.nested).map((a) => a.reason)).toEqual([])
  }, 30_000)

  it("an org without a cap takes no lock and runs no count", async () => {
    const { orgId, adminUserId } = await minimal.secondOrg()
    PrivilegedDbTestAccess.record()
    await withPrivilegedDb(orgId, "t-free-connect", (tx) =>
      createCredentialConnection(tx, orgId, adminUserId, "mail", "imap", {
        identifier: "free@caps.test",
        credentials: { username: "free@caps.test", password: "x" },
        ownerType: "org",
      }),
    )
    const recorded = PrivilegedDbTestAccess.recorded()
    expect(recorded.map((a) => a.reason).filter((r) => r.startsWith("org-caps"))).toEqual([])
  }, 30_000)
})

describe("storage", () => {
  it("the quota is read from caps, never from settings.storageQuotaGb", async () => {
    const { orgId } = await minimal.secondOrg()
    await sql`UPDATE kernel.organizations SET settings = settings || '{"storageQuotaGb": 3}'::jsonb, caps = '{}'::jsonb WHERE id = ${orgId}`
    const unlimited = await withPrivilegedDb(orgId, "t", (tx) => loadOrgSettings(tx, orgId))
    expect(orgQuotaBytes(unlimited)).toBeNull()
    await setCaps(orgId, { storageGb: 5 })
    const capped = await withPrivilegedDb(orgId, "t", (tx) => loadOrgSettings(tx, orgId))
    expect(orgQuotaBytes(capped)).toBe(5 * 1024 ** 3)
  })

  it("the migration maps the historical default 10 to unlimited and keeps a chosen value", async () => {
    const file = readFileSync(
      path.join(import.meta.dir, "../../db/migrations/0237_organizations_caps.sql"),
      "utf8",
    )
    const update = file
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .find((s) => s.startsWith("UPDATE kernel.organizations"))
    if (!update) throw new Error("migration UPDATE not found")
    const orgs = await Promise.all([1, 2, 3, 4, 5].map(() => minimal.secondOrg()))
    // 2.5 GB was someone's choice too: copied rounded up, as a cap is whole GB.
    const quotas = [10, 25, 0, null, 2.5]
    for (const [i, o] of orgs.entries()) {
      const q = quotas[i]
      await sql`UPDATE kernel.organizations
        SET caps = '{}'::jsonb,
            settings = ${q === null ? sql`settings - 'storageQuotaGb'` : sql`settings || jsonb_build_object('storageQuotaGb', ${q}::numeric)`}
        WHERE id = ${o.orgId}`
    }
    await sql.unsafe(update)
    const caps = await Promise.all(orgs.map((o) => readOrgCaps(o.orgId)))
    expect(caps).toEqual([{}, { storageGb: 25 }, {}, {}, { storageGb: 3 }])
    // A new org no longer carries the key.
    const [fresh] =
      await sql`SELECT settings FROM kernel.organizations WHERE id = ${orgs[0]!.orgId}`
    expect(fresh).toBeDefined()
    const [def] = await sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'kernel' AND table_name = 'organizations' AND column_name = 'settings'`
    expect(String(def.column_default)).not.toContain("storageQuotaGb")
  })
})

describe("operator only", () => {
  it("an org admin cannot set caps through PATCH /api/org (400), nor the old storage setting", async () => {
    const { orgId, adminUserId } = await minimal.secondOrg()
    const auth = { Authorization: `Bearer ${await minimal.token(adminUserId)}` }
    const patch = (body: unknown) =>
      app.request("/api/org", {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    expect((await patch({ caps: { seats: 999 } })).status).toBe(400)
    expect((await patch({ name: "X", caps: { seats: 999 } })).status).toBe(400)
    expect((await patch({ settings: { storageQuotaGb: 999 } })).status).toBe(400)
    expect(await readOrgCaps(orgId)).toEqual({})
  })

  it("limits is CLI only: no config_limits tool, and the provisioner refuses the tool path", async () => {
    const { orgId } = await minimal.secondOrg()
    expect(isConfigToolSection("limits")).toBe(false)
    registerConfigTools(orgId)
    expect(toolRegistry.get([orgId, "kernel", "config_limits"])).toBeUndefined()
    const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
    ctx.orgId = orgId
    ctx.toolPath = true
    const refused = await limitsProvisioner
      .plan(ctx, { limits: { seats: 99 } } as never)
      .catch((e) => e)
    expect(String(refused?.message)).toContain("never through an agent")
    expect(await readOrgCaps(orgId)).toEqual({})
  })

  it("config apply's limits section sets, keeps and unsets caps", async () => {
    const { orgId } = await minimal.secondOrg()
    const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
    ctx.orgId = orgId
    const apply = (limits: unknown) =>
      limitsProvisioner.apply(ctx, { actions: [] }, { limits } as never)
    const first = await apply({ seats: 5, storageGb: 20 })
    expect(first.changed).toEqual(["limits.caps"])
    expect(await readOrgCaps(orgId)).toEqual({ seats: 5, storageGb: 20 })
    expect((await apply({ seats: 5 })).unchanged).toEqual(["limits"])
    await apply({ storageGb: null, jobsPerHour: 100 })
    expect(await readOrgCaps(orgId)).toEqual({ seats: 5, jobsPerHour: 100 })
  })

  it("liaison org caps sets, unsets and prints, and refuses bad input", async () => {
    const { orgId } = await minimal.secondOrg()
    const set = await runOrgCapsCli([orgId, "--seats", "3", "--mailboxes", "2"])
    expect(set.exitCode).toBe(0)
    expect(set.report?.caps).toEqual({ seats: 3, mailboxes: 2 })
    const unset = await runOrgCapsCli([orgId, "--unset", "seats", "--jobs-per-hour", "50"])
    expect(unset.report?.caps).toEqual({ mailboxes: 2, jobsPerHour: 50 })
    const more = await runOrgCapsCli([orgId, "--custom-apps", "4", "--audit-days", "90"])
    expect(more.report?.caps).toEqual({
      mailboxes: 2,
      jobsPerHour: 50,
      customApps: 4,
      auditDays: 90,
    })
    await runOrgCapsCli([orgId, "--unset", "custom-apps", "--unset", "audit-days"])
    const show = await runOrgCapsCli([orgId])
    expect(show.report?.changed).toBe(false)
    expect((show.report?.usage as { seats: unknown } | undefined)?.seats).toEqual({
      used: 1,
      limit: null,
    })
    expect((await runOrgCapsCli([orgId, "--seats", "-1"])).exitCode).toBe(2)
    expect((await runOrgCapsCli([orgId, "--seats", "2", "--unset", "seats"])).exitCode).toBe(2)
    expect((await runOrgCapsCli(["no-such-org-slug"])).exitCode).toBe(2)
  })
})

describe("cap values", () => {
  it("every cap is a whole number >= 1: 0 is refused by the CLI, the limits section, setOrgCaps and the column", async () => {
    const { orgId } = await minimal.secondOrg()
    for (const flag of [
      "--seats",
      "--mailboxes",
      "--storage-gb",
      "--jobs-per-hour",
      "--custom-apps",
      "--audit-days",
    ]) {
      const res = await runOrgCapsCli([orgId, flag, "0"])
      expect(res.exitCode).toBe(2)
      expect(String(res.message)).toContain("--unset")
    }
    for (const kind of [
      "seats",
      "mailboxes",
      "storageGb",
      "jobsPerHour",
      "customApps",
      "auditDays",
    ]) {
      expect(limitsSchema.safeParse({ [kind]: 0 }).success).toBe(false)
      expect(limitsSchema.safeParse({ [kind]: 1 }).success).toBe(true)
      expect(orgCapsSchema.safeParse({ [kind]: 0 }).success).toBe(false)
    }
    await expect(setOrgCaps(orgId, { set: { jobsPerHour: 0 } })).rejects.toThrow()
    // The bound comes from the one table: above it is refused everywhere too.
    expect(limitsSchema.safeParse({ auditDays: 3651 }).success).toBe(false)
    expect(orgCapsSchema.safeParse({ customApps: 10_001 }).success).toBe(false)
    expect(await readOrgCaps(orgId)).toEqual({})
    // The column refuses what the parsers would: 0, a fraction, a string.
    for (const bad of [{ seats: 0 }, { storageGb: 0.5 }, { jobsPerHour: -3 }, { mailboxes: "2" }]) {
      const err = await setCaps(orgId, bad).catch((e) => e)
      expect(String(err?.message ?? err)).toContain("organizations_caps_valid")
    }
    // Whole numbers, null (unlimited) and keys a later release may add are fine.
    await setCaps(orgId, { seats: 3, storageGb: null, laterCap: 0 })
    expect(await readOrgCaps(orgId)).toEqual({ seats: 3 })
  })

  it("a stored value under 1 reads as unlimited, never as a cap of 0", () => {
    expect(normalizeCaps({ jobsPerHour: 0, seats: 0.5, mailboxes: 2 })).toEqual({ mailboxes: 2 })
  })
})

describe("usage API", () => {
  it("GET /api/org/usage gives each cap as used / limit to an org admin", async () => {
    const { orgId, adminUserId } = await minimal.secondOrg()
    await setCaps(orgId, { seats: 4 })
    const res = await app.request("/api/org/usage", {
      headers: { Authorization: `Bearer ${await minimal.token(adminUserId)}` },
    })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: Record<string, unknown> }
    expect(data).toEqual({
      storageEstimate: null,
      seats: { used: 1, limit: 4 },
      mailboxes: { used: 0, limit: null },
      storageGb: { used: 0, limit: null },
      jobsThisHour: { used: 0, limit: null },
    })
  })

  it("users:admin without org:admin → 403", async () => {
    const { orgId } = await minimal.secondOrg()
    const member = await minimal.person(orgId)
    await minimal.grantScope(member.id, "kernel:users:admin")
    const res = await app.request("/api/org/usage", {
      headers: { Authorization: `Bearer ${await minimal.token(member.id)}` },
    })
    expect(res.status).toBe(403)
  })
})

describe("notices", () => {
  // A running server has the kernel emit set loaded (initEventBus), and
  // tx.queueEvent refuses an undeclared kernel event only then. Load it here as
  // the server does, so a notice the kernel does not declare fails this test
  // instead of passing on an empty set.
  beforeAll(() => {
    declaredEmits.set("kernel", new Set(KERNEL_DECLARED_EMITS))
  })

  async function notices(orgId: string): Promise<Array<{ threshold: number }>> {
    const rows = await sql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'entity' = 'org_cap'
      ORDER BY seq`
    return rows.map((r) => (r.payload as { data: { threshold: number } }).data)
  }

  it("80 % notifies once, 100 % once, and a drop below re-arms the next crossing", async () => {
    const { orgId } = await minimal.secondOrg()
    await redis.del(`orgcap:level:${orgId}:seats`)
    await evaluateCapLevel(orgId, "seats", 8, 10)
    await evaluateCapLevel(orgId, "seats", 9, 10)
    expect((await notices(orgId)).map((n) => n.threshold)).toEqual([80])
    await evaluateCapLevel(orgId, "seats", 10, 10)
    await evaluateCapLevel(orgId, "seats", 10, 10)
    expect((await notices(orgId)).map((n) => n.threshold)).toEqual([80, 100])
    await evaluateCapLevel(orgId, "seats", 5, 10)
    await evaluateCapLevel(orgId, "seats", 8, 10)
    expect((await notices(orgId)).map((n) => n.threshold)).toEqual([80, 100, 80])
  })

  it("a notice that could not be queued is not recorded as sent: the next evaluation retries it", async () => {
    const { orgId } = await minimal.secondOrg()
    await redis.del(`orgcap:level:${orgId}:seats`)
    // The kernel refuses the notice (as it did while org_cap:threshold was undeclared).
    declaredEmits.set("kernel", new Set(["message:create"]))
    try {
      await evaluateCapLevel(orgId, "seats", 8, 10)
    } finally {
      declaredEmits.set("kernel", new Set(KERNEL_DECLARED_EMITS))
    }
    expect(await notices(orgId)).toEqual([])
    expect(await redis.get(`orgcap:level:${orgId}:seats`)).toBeNull()
    // Same usage, the notice goes out now, once.
    await evaluateCapLevel(orgId, "seats", 8, 10)
    await evaluateCapLevel(orgId, "seats", 8, 10)
    expect((await notices(orgId)).map((n) => n.threshold)).toEqual([80])
    expect(await redis.get(`orgcap:level:${orgId}:seats`)).toBe("80")
  })

  it("storage notices come from what is stored: a refused 50 GB write into a 10 GB cap notifies nothing", async () => {
    const { orgId } = await minimal.secondOrg()
    await setCaps(orgId, { storageGb: 10 })
    await redis.del(`orgcap:level:${orgId}:storageGb`)
    const refused = await withPrivilegedDb(orgId, "t", async (tx) =>
      wouldExceedOrgQuota(tx, orgId, await loadOrgSettings(tx, orgId), 50 * 1024 ** 3),
    )
    expect(refused).toBe(true)
    // A 9 GB write that fits is not stored yet either: no 80 % notice for it.
    const fits = await withPrivilegedDb(orgId, "t", async (tx) =>
      wouldExceedOrgQuota(tx, orgId, await loadOrgSettings(tx, orgId), 9 * 1024 ** 3),
    )
    expect(fits).toBe(false)
    await capLevelsSettled()
    expect(await notices(orgId)).toEqual([])
    expect(await redis.get(`orgcap:level:${orgId}:storageGb`)).toBeNull()
  })

  it("a refused accept tells the admins the limit is reached", async () => {
    const { orgId } = await minimal.secondOrg()
    await setCaps(orgId, { seats: 1 })
    await accept(await invite(orgId, "n@caps.test"), "N")
    await capLevelsSettled()
    const sent = await notices(orgId)
    expect(sent.map((n) => n.threshold)).toContain(100)
    const [row] = await sql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'entity' = 'org_cap' LIMIT 1`
    expect((row.payload as { data: { summary: string } }).data.summary).toContain(
      "whoever runs the server",
    )
  })

  it("the storage notice is written in the org's language", async () => {
    const { orgId } = await minimal.secondOrg()
    const summaryAt = async (gb: number) => {
      const [row] = await sql`
        SELECT payload FROM kernel.pending_events
        WHERE org_id = ${orgId} AND payload->>'entity' = 'org_cap'
          AND (payload->'data'->>'used')::numeric = ${gb}
        ORDER BY seq DESC LIMIT 1`
      return (row?.payload as { data: { summary: string } } | undefined)?.data.summary
    }
    await sql`UPDATE kernel.organizations SET default_locale = 'fr-FR' WHERE id = ${orgId}`
    await redis.del(`orgcap:level:${orgId}:storageGb`)
    await evaluateCapLevel(orgId, "storageGb", 8.5, 10)
    expect(await summaryAt(8.5)).toBe(
      "Stockage : 8.5 Go sur 10 Go utilisés, 80 % de la limite. Passez à une offre supérieure ou libérez de l'espace (demandez à la personne qui gère le serveur de relever la limite), sinon les nouveaux fichiers seront refusés une fois le stockage plein.",
    )
    await sql`UPDATE kernel.organizations SET default_locale = 'en-US' WHERE id = ${orgId}`
    await redis.del(`orgcap:level:${orgId}:storageGb`)
    await evaluateCapLevel(orgId, "storageGb", 8.25, 10)
    expect(await summaryAt(8.25)).toBe(
      "Storage: 8.25 GB of 10 GB used, 80 % of the limit. Upgrade your plan or free space (ask whoever runs the server to raise the limit), otherwise new files will be refused once storage is full.",
    )
  })
})
