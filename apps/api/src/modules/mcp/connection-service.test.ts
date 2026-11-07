// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { mcpConnections, users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { createSession } from "~/modules/auth/auth"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { verifyAccessToken } from "~/modules/auth/jwt"
import {
  createMcpConnection,
  listConnectionsForUser,
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  mintAccessToken,
  refreshAccessToken,
  resolveConnectionFromToken,
  revokeConnection,
} from "~/modules/mcp/connection-service"
import {
  archiveAgent,
  cleanupSeededOrg,
  grantScope,
  revokeScope,
  seedAgentForOrg,
  seedOrgWithUser,
  sqlUpdateCeiling,
} from "~/modules/mcp/test-helpers"
import { KERNEL_EVERY_MEMBER_SCOPES } from "~/modules/permissions/every-member-scopes"
import { createExternalUser } from "~/modules/users/external-user"

describe("mcp connection service", () => {
  const orgs: string[] = []
  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  it("an external row's connection mints no token, on first mint or on refresh", async () => {
    const { orgId } = await seedOrgWithUser()
    orgs.push(orgId)
    const created = await withPrivilegedDb(orgId, "mcp-external-test", (tx) =>
      createExternalUser(tx, {
        orgId,
        companyId: crypto.randomUUID(),
        email: `client-${crypto.randomUUID().slice(0, 8)}@client.example`,
        name: "Client",
      }),
    )
    if (!created.ok) throw new Error(created.code)
    const { connection, refreshToken } = await createMcpConnection({
      orgId,
      userId: created.userId,
      clientId: "client-x",
      label: "Claude Code",
    })
    await expect(mintAccessToken(connection.id)).rejects.toThrow("external user")
    await expect(refreshAccessToken(refreshToken)).rejects.toThrow("external user")
  })

  it("TTL is 15 minutes", () => {
    expect(MCP_ACCESS_TOKEN_TTL_SECONDS).toBe(900)
  })

  it("creates a connection, mints a token, resolves it to owner+org", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { connection: conn } = await createMcpConnection({
      orgId,
      userId,
      clientId: "client-x",
      label: "Claude Code",
    })
    const { token } = await mintAccessToken(conn.id)
    expect((await verifyAccessToken(token, env.JWT_SECRET)).mcpConnectionId).toBe(conn.id)
    const resolved = await resolveConnectionFromToken(token)
    expect(resolved.connectionId).toBe(conn.id)
    expect(resolved.userId).toBe(userId)
    expect(resolved.orgId).toBe(orgId)
  })

  it("stamps last_used_at on mint, not before", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { connection: conn } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    const [pre] = await withSystemDb("t", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, conn.id)),
    )
    expect(pre.lastUsedAt).toBeNull()
    await mintAccessToken(conn.id)
    const [post] = await withSystemDb("t", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, conn.id)),
    )
    expect(post.lastUsedAt).not.toBeNull()
  })

  it("revoke sets revoked_at and blocks subsequent mint", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { connection: conn } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    await revokeConnection(conn.id, userId)
    const [row] = await withSystemDb("t", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, conn.id)),
    )
    expect(row.revokedAt).not.toBeNull()
    await expect(mintAccessToken(conn.id)).rejects.toThrow(/revoked|not found/i)
  })

  it("deactivated owner cannot mint or refresh (parity with REST auth)", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { connection: conn, refreshToken } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    // Active owner mints fine.
    await mintAccessToken(conn.id)
    // Owner is deactivated out-of-band.
    await withSystemDb("t", (db) =>
      db.update(users).set({ status: "deactivated" }).where(eq(users.id, userId)),
    )
    invalidateAuthCache(userId)
    await expect(mintAccessToken(conn.id)).rejects.toThrow(/not active/i)
    await expect(refreshAccessToken(refreshToken)).rejects.toThrow(/not active/i)
  })

  it("resolveConnectionFromToken rejects a LEGACY connection's token on the very next call after revoke", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { connection: conn } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    const { token } = await mintAccessToken(conn.id)
    expect((await resolveConnectionFromToken(token)).connectionId).toBe(conn.id)
    await revokeConnection(conn.id, userId)
    // No grace window to the token's expiry: an unbound connection is judged per request too.
    await expect(resolveConnectionFromToken(token)).rejects.toThrow(/revoked/i)
    await expect(mintAccessToken(conn.id)).rejects.toThrow()
  })

  it("revoke only by owner", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { connection: conn } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    await expect(
      revokeConnection(conn.id, "00000000-0000-0000-0000-000000000999"),
    ).rejects.toThrow()
  })

  it("refresh secret is high-entropy and not the connection id (B1)", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { connection: conn, refreshToken } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    // Format is `<connId>.<secret>` — the secret half must not be empty/derivable.
    expect(refreshToken.startsWith(`${conn.id}.`)).toBe(true)
    const secret = refreshToken.slice(conn.id.length + 1)
    expect(secret.length).toBeGreaterThanOrEqual(32)
    expect(secret).not.toBe(conn.id)
    // The raw secret is never persisted — only its hash.
    const [row] = await withSystemDb("t", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, conn.id)),
    )
    expect(row.refreshTokenHash).toBeTruthy()
    expect(row.refreshTokenHash).not.toContain(secret)
  })

  it("refresh_token grant: bare connection id (no secret) cannot mint (B1)", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { connection: conn, refreshToken } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    // The connection id alone is NOT a bearer credential.
    await expect(refreshAccessToken(conn.id)).rejects.toThrow()
    // A wrong secret with the right id is rejected (constant-time mismatch).
    await expect(
      refreshAccessToken(`${conn.id}.deadbeefdeadbeefdeadbeefdeadbeef`),
    ).rejects.toThrow()
    // The genuine secret mints a token.
    const { token } = await refreshAccessToken(refreshToken)
    expect((await verifyAccessToken(token, env.JWT_SECRET)).mcpConnectionId).toBe(conn.id)
  })

  it("refresh_token grant honors revocation (B1)", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { connection: conn, refreshToken } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    await revokeConnection(conn.id, userId)
    await expect(refreshAccessToken(refreshToken)).rejects.toThrow(/revoked|not found/i)
  })

  it("MCP connection NOT evicted by the login session cap (N3)", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { connection: conn } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    // Drive well past MAX_SESSIONS_PER_USER (10) login sessions.
    for (let i = 0; i < 13; i++) await createSession(userId, orgId)
    const [row] = await withSystemDb("t", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, conn.id)),
    )
    expect(row).toBeDefined()
    expect(row.revokedAt).toBeNull()
  })

  it("owner delete cascades to mcp_connections (N3)", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { connection: conn } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    await withSystemDb("t", (db) => db.delete(users).where(eq(users.id, userId)))
    const rows = await withSystemDb("t", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, conn.id)),
    )
    expect(rows.length).toBe(0)
  })

  // ---- P3-T02: mcp_connections carries an optional agent binding ----------

  it("mcp connections table accepts a nullable agent id", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId)
    const [row] = await withSystemDb("t", (db) =>
      db
        .insert(mcpConnections)
        .values({
          orgId,
          userId,
          clientId: "c",
          label: "L",
          refreshTokenHash: "hash",
          agentId,
        })
        .returning(),
    )
    expect(row.agentId).toBe(agentId)
    const [legacy] = await withSystemDb("t", (db) =>
      db
        .insert(mcpConnections)
        .values({ orgId, userId, clientId: "c", label: "L2", refreshTokenHash: "hash2" })
        .returning(),
    )
    expect(legacy.agentId).toBeNull()
  })

  it("mcp connections table rejects a foreign or nonexistent agent id", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const other = await seedOrgWithUser()
    orgs.push(other.orgId)
    const foreign = await seedAgentForOrg(other.orgId)
    const insertWith = (agentId: string) =>
      withSystemDb("t", (db) =>
        db
          .insert(mcpConnections)
          .values({ orgId, userId, clientId: "c", label: "L", refreshTokenHash: "h", agentId })
          .returning(),
      )
    // Drizzle wraps the driver error, so the constraint name lives on the
    // cause, not on the outer "Failed query" message.
    const expectAgentFkViolation = async (agentId: string) => {
      let err: any
      try {
        await insertWith(agentId)
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      const chain = [err?.message, err?.cause?.message, err?.cause?.constraint_name].join(" ")
      expect(chain).toMatch(/mcp_connections_agent_org_fk|foreign key/i)
    }
    await expectAgentFkViolation("00000000-0000-4000-8000-0000000073ff")
    // The key is composite (agent_id, org_id), so another org's real agent is
    // refused exactly like a nonexistent one.
    await expectAgentFkViolation(foreign.agentId)
  })

  // ---- P3-T04: createMcpConnection binds an agent ------------------------

  it("createMcpConnection persists agentId when provided", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId)
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "Agent bound",
      agentId,
    })
    expect(connection.agentId).toBe(agentId)
    const [row] = await withSystemDb("t", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, connection.id)),
    )
    expect(row.agentId).toBe(agentId)
  })

  it("createMcpConnection rejects an agent belonging to a different org", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const other = await seedOrgWithUser()
    orgs.push(other.orgId)
    const foreign = await seedAgentForOrg(other.orgId)
    await expect(
      createMcpConnection({ orgId, userId, clientId: "c", label: "L", agentId: foreign.agentId }),
    ).rejects.toThrow(/unknown or foreign org agent/i)
    await expect(
      createMcpConnection({
        orgId,
        userId,
        clientId: "c",
        label: "L",
        agentId: "00000000-0000-4000-8000-0000000074ff",
      }),
    ).rejects.toThrow(/unknown or foreign org agent/i)
  })

  it("createMcpConnection refuses an archived agent, like a missing one", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId)
    await archiveAgent(agentId)
    await expect(
      createMcpConnection({ orgId, userId, clientId: "c", label: "L", agentId }),
    ).rejects.toThrow(/unknown or foreign org agent/i)
  })

  // ---- P3-T05: mint narrows to ceiling INTERSECT the grantor's live grants -

  const GRANTOR_SCOPES = ["kernel:agents:admin", "finance:read", "logistics:read"]
  /** What the grantor resolves to: the grants plus what every member holds. */
  const GRANTOR_TOKEN_SCOPES = [...GRANTOR_SCOPES, ...KERNEL_EVERY_MEMBER_SCOPES]

  async function seedGrantor() {
    const seeded = await seedOrgWithUser()
    for (const scope of GRANTOR_SCOPES) await grantScope(seeded.orgId, seeded.userId, scope)
    return seeded
  }

  it("mintAccessToken narrows scopes to the agent ceiling intersection", async () => {
    const { orgId, userId } = await seedGrantor()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId, { scopeCeiling: ["finance:read"] })
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
      agentId,
    })
    const { token } = await mintAccessToken(connection.id)
    const decoded = await verifyAccessToken(token, env.JWT_SECRET)
    expect(decoded.scopes).toEqual(["finance:read"])
    expect(decoded.agentId).toBe(agentId)
    expect(decoded.grantorUserId).toBe(userId)
    // Audit-only record of what was minted.
    const [row] = await withSystemDb("t", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, connection.id)),
    )
    expect(row.mintScopeSnapshot).toEqual(["finance:read"])
  })

  it("mintAccessToken does not narrow a connection with no agentId", async () => {
    const { orgId, userId } = await seedGrantor()
    orgs.push(orgId)
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    const { token } = await mintAccessToken(connection.id)
    const decoded = await verifyAccessToken(token, env.JWT_SECRET)
    expect([...(decoded.scopes ?? [])].sort()).toEqual([...GRANTOR_TOKEN_SCOPES].sort())
    expect(decoded.agentId).toBeUndefined()
    expect(decoded.grantorUserId).toBeUndefined()
    const [row] = await withSystemDb("t", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, connection.id)),
    )
    expect(row.mintScopeSnapshot).toBeNull()
  })

  it("mintAccessToken refuses an agent bound connection whose agent was archived", async () => {
    const { orgId, userId } = await seedGrantor()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId, { scopeCeiling: ["finance:read"] })
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
      agentId,
    })
    await mintAccessToken(connection.id)
    await archiveAgent(agentId)
    await expect(mintAccessToken(connection.id)).rejects.toThrow(/agent not available/i)
  })

  // ---- P3-T06: per-request recomputation, never the token's baked scopes --

  it("resolveConnectionFromToken recomputes agent bound scopes live, ignoring a stale token payload", async () => {
    const { orgId, userId } = await seedGrantor()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId, {
      scopeCeiling: ["finance:read", "logistics:read"],
    })
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
      agentId,
    })
    const { token } = await mintAccessToken(connection.id)
    expect((await verifyAccessToken(token, env.JWT_SECRET)).scopes).toContain("logistics:read")

    // The grantor loses a scope well inside the token's 15 minute TTL.
    await revokeScope(orgId, userId, "logistics:read")

    const resolved = await resolveConnectionFromToken(token)
    expect(resolved.scopes).toEqual(["finance:read"])
    expect(resolved.agentId).toBe(agentId)
  })

  it("resolveConnectionFromToken narrows live to the agent ceiling when the CEILING shrinks mid TTL", async () => {
    const { orgId, userId } = await seedGrantor()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId, {
      scopeCeiling: ["finance:read", "logistics:read"],
    })
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
      agentId,
    })
    const { token } = await mintAccessToken(connection.id)
    await sqlUpdateCeiling(agentId, ["finance:read"])
    const resolved = await resolveConnectionFromToken(token)
    expect(resolved.scopes).toEqual(["finance:read"])
  })

  it("resolveConnectionFromToken recomputes a LEGACY token's scopes from the grantor's live grants", async () => {
    const { orgId, userId } = await seedGrantor()
    orgs.push(orgId)
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    const { token } = await mintAccessToken(connection.id)
    await revokeScope(orgId, userId, "logistics:read")
    const resolved = await resolveConnectionFromToken(token)
    // A demotion applies on the next call, not at the end of the token's 15 minutes.
    expect(resolved.scopes).not.toContain("logistics:read")
    expect([...resolved.scopes].sort()).toEqual(
      GRANTOR_TOKEN_SCOPES.filter((sc) => sc !== "logistics:read").sort(),
    )
    expect(resolved.agentId).toBeUndefined()
  })

  it("resolveConnectionFromToken refuses an agent bound token after the agent is archived mid TTL", async () => {
    const { orgId, userId } = await seedGrantor()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId, { scopeCeiling: ["finance:read"] })
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
      agentId,
    })
    const { token } = await mintAccessToken(connection.id)
    await archiveAgent(agentId)
    await expect(resolveConnectionFromToken(token)).rejects.toThrow(/agent not available/i)
  })

  // ---- P3-T07: grantor deactivation revokes an agent bound token mid TTL --

  async function deactivate(userId: string) {
    await withSystemDb("t", (db) =>
      db.update(users).set({ status: "deactivated" }).where(eq(users.id, userId)),
    )
    invalidateAuthCache(userId)
  }

  it("resolveConnectionFromToken rejects an agent bound token after the grantor is deactivated mid TTL", async () => {
    const { orgId, userId } = await seedGrantor()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId, { scopeCeiling: ["finance:read"] })
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
      agentId,
    })
    const { token } = await mintAccessToken(connection.id)
    await deactivate(userId)
    await expect(resolveConnectionFromToken(token)).rejects.toThrow(/owner not active/i)
  })

  it("a deactivated grantor's LEGACY token stops resolving on the next call", async () => {
    const { orgId, userId } = await seedGrantor()
    orgs.push(orgId)
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    const { token } = await mintAccessToken(connection.id)
    await deactivate(userId)
    await expect(resolveConnectionFromToken(token)).rejects.toThrow(/owner not active/i)
    await expect(mintAccessToken(connection.id)).rejects.toThrow(/not active/i)
  })

  // ---- P3-T08: revocation applies on the very next request ---------------
  // The legacy (unbound) half of this rule is pinned above: it is judged per request too.

  it("a revoked agent bound connection's already minted token is rejected on the next resolveConnectionFromToken call", async () => {
    const { orgId, userId } = await seedGrantor()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId, { scopeCeiling: ["finance:read"] })
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
      agentId,
    })
    const { token } = await mintAccessToken(connection.id)
    expect((await resolveConnectionFromToken(token)).scopes).toEqual(["finance:read"])
    await revokeConnection(connection.id, userId)
    await expect(resolveConnectionFromToken(token)).rejects.toThrow(/revoked/i)
  })

  // ---- P3-T26: the listing tells agent bound and legacy connections apart -

  it("listConnectionsForUser returns agentId for an agent bound connection and null for a legacy one", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId)
    const bound = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "Bound",
      agentId,
    })
    const legacy = await createMcpConnection({ orgId, userId, clientId: "c", label: "Legacy" })
    const rows = await listConnectionsForUser(orgId, userId)
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(bound.connection.id)?.agentId).toBe(agentId)
    expect(byId.get(legacy.connection.id)?.agentId).toBeNull()
  })

  // ---- FX1: the token's agent claim and the connection row must agree ------

  it("a token whose agent claim disagrees with the connection row is refused", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId, { scopeCeiling: ["finance:read"] })
    const other = await seedAgentForOrg(orgId, { scopeCeiling: ["finance:read"] })
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "Bound",
      agentId,
    })
    const { token } = await mintAccessToken(connection.id)
    expect((await resolveConnectionFromToken(token)).agentId).toBe(agentId)

    // The binding is REBOUND out of band. The still-valid token names the old
    // agent, so the two disagree and nothing may act on either reading.
    await sql`UPDATE kernel.mcp_connections SET agent_id = ${other.agentId} WHERE id = ${connection.id}`
    await expect(resolveConnectionFromToken(token)).rejects.toThrow(/agent/i)

    // An agent claim on a connection that carries none is refused too.
    await sql`UPDATE kernel.mcp_connections SET agent_id = NULL WHERE id = ${connection.id}`
    await expect(resolveConnectionFromToken(token)).rejects.toThrow(/agent/i)
  })

  // FX2 item 6: the belt ran AFTER the claim-less early return, so the one
  // direction it could not see was the one that mattered -- a LEGACY token
  // (minted before the binding, or by a client that simply omits the claim)
  // against a row that is now agent-bound. That token kept its full baked
  // scopes, unnarrowed by the ceiling and unaffected by revocation, which is
  // exactly the authority the binding exists to take away.
  it("refuses a claim-less token against a connection that IS agent bound", async () => {
    const { orgId, userId } = await seedGrantor()
    orgs.push(orgId)
    const { agentId } = await seedAgentForOrg(orgId, { scopeCeiling: ["finance:read"] })
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "Legacy then bound",
    })
    // Minted while the connection carried no agent, so the token has no claim.
    const { token } = await mintAccessToken(connection.id)
    expect((await verifyAccessToken(token, env.JWT_SECRET)).agentId).toBeUndefined()

    await sql`UPDATE kernel.mcp_connections SET agent_id = ${agentId} WHERE id = ${connection.id}`
    await expect(resolveConnectionFromToken(token)).rejects.toThrow(/agent/i)
  })
})
