// SPDX-License-Identifier: FSL-1.1-ALv2
import { timingSafeEqual } from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { agents, mcpConnections, users } from "~/db/schema/kernel"
import { generateToken, hashToken } from "~/lib/crypto"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { isMentionableAgent } from "~/modules/agent/directory/listing"
import { type TaintOriginRows, UNKNOWN_TURN_TAINT } from "~/modules/agent/scopes/scope-taint"
import { intersectScopes } from "~/modules/agent/subruns/spawn-agent"
import { getUserAuthState } from "~/modules/auth/auth-state"
import { signAccessToken, verifyAccessToken } from "~/modules/auth/jwt"
import { orgRefusesNonSessionCredentials } from "~/modules/cloud/suspension"
import { isDemoOrgExpiredNow } from "~/modules/demo/demo-expiry"
// Verified path: decide.ts imports loadEffectivePermissions from here; return
// type EffectivePermissions = { roles, scopes, dimensionGrants }.
import { loadEffectivePermissions } from "~/modules/permissions/permissions"

export const MCP_ACCESS_TOKEN_TTL_SECONDS = 900 // 15 min — bounds revoke→401 window (spec Acceptance)

// The refresh token is `<connId>.<secret>`: the id keeps lookup O(1), the
// high-entropy secret is the actual bearer credential and only its hash is
// persisted (spec C2 — hashed long-lived credential material distinct from id).
export function formatRefreshToken(connectionId: string, secret: string): string {
  return `${connectionId}.${secret}`
}

function parseRefreshToken(refreshToken: string): { connectionId: string; secret: string } | null {
  const dot = refreshToken.indexOf(".")
  if (dot <= 0 || dot === refreshToken.length - 1) return null
  return {
    connectionId: refreshToken.slice(0, dot),
    secret: refreshToken.slice(dot + 1),
  }
}

function secretMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(presented), "hex")
  const b = Buffer.from(storedHash, "hex")
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Load a live (non-archived) agent of this org, or null. Exported so the two
 * minting routes (device grant, authorization-code exchange) validate an
 * offered `agentId` against the SAME rule `createMcpConnection` enforces,
 * rather than re-deriving one and drifting from it.
 *
 * Load a live (non-archived) agent of this org, or null. An ARCHIVED agent is
 * treated exactly like a missing one everywhere in this file: an archived
 * agent is one an admin has taken out of service, so it must not be bound to
 * a new connection, must not mint, and must not authorize a request against
 * an already-minted token. Its ceiling is no longer maintained, so honouring
 * it would keep serving a scope set nobody is curating.
 */
export async function loadLiveAgent(
  orgId: string,
  agentId: string,
): Promise<{ id: string; scopeCeiling: string[] } | null> {
  const [row] = await withSystemDb("mcp-conn-agent-load", (db) =>
    db
      .select({ id: agents.id, scopeCeiling: agents.scopeCeiling })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt))),
  )
  return row ?? null
}

/**
 * An agent this person may BIND a new MCP connection to: live, of their org, and
 * one they could address anyway (the mention picker's own predicate). Not the
 * org's system agent, and not a personal agent somebody else owns: a connection
 * bound to an agent acts, and is recorded, as that agent. The same rule the
 * desktop's local-session claim applies (`requireClaimableAgent`).
 */
export async function loadBindableAgent(
  orgId: string,
  userId: string,
  agentId: string,
): Promise<{ id: string; scopeCeiling: string[] } | null> {
  const agent = await loadLiveAgent(orgId, agentId)
  if (!agent) return null
  return (await isMentionableAgent(orgId, userId, agentId)) ? agent : null
}

export async function createMcpConnection(input: {
  orgId: string
  userId: string
  clientId: string
  label: string
  /** Bind the connection to an agent: its token is narrowed to that agent's
   *  live ceiling, and re-derived per request. Absent = legacy connection. */
  agentId?: string
}): Promise<{ connection: typeof mcpConnections.$inferSelect; refreshToken: string }> {
  if (input.agentId && !(await loadBindableAgent(input.orgId, input.userId, input.agentId))) {
    // Checked here as well as by the composite foreign key, so a foreign-org
    // or archived agent fails with a named error instead of a driver 23503, and
    // here rather than only in the routes, so no minting path can bind a person
    // to an agent that is not theirs to act as.
    throw new Error("mcp connection: unknown or foreign org agent")
  }
  const secret = generateToken(32)
  const [row] = await withSystemDb("mcp-conn-create", (db) =>
    db
      .insert(mcpConnections)
      .values({ ...input, refreshTokenHash: hashToken(secret) })
      .returning(),
  )
  return { connection: row, refreshToken: formatRefreshToken(row.id, secret) }
}

// Mint an access token for an already-authenticated connection. Callers MUST
// have proven identity out-of-band (auth-code+PKCE exchange, device grant).
// This does NOT accept the connection id as a bearer credential — the
// `refresh_token` grant must go through `refreshAccessToken` which verifies
// the high-entropy secret.
export async function mintAccessToken(connectionId: string): Promise<{ token: string }> {
  // Re-read to enforce revocation at mint/refresh (NOT per call).
  const [conn] = await withSystemDb("mcp-conn-load", (db) =>
    db.select().from(mcpConnections).where(eq(mcpConnections.id, connectionId)),
  )
  if (!conn) throw new Error("mcp connection not found")
  if (conn.revokedAt) throw new Error("mcp connection revoked")
  if (await isDemoOrgExpiredNow(conn.orgId)) throw new Error("mcp demo workspace expired")
  if (await orgRefusesNonSessionCredentials(conn.orgId)) throw new Error("mcp org suspended")

  // Parity with the REST authMiddleware (same getUserAuthState source): a
  // deactivated/suspended/deleted owner must not keep minting MCP tokens. The
  // in-app agent path enforces status === "active"; MCP must not diverge.
  const ownerState = await getUserAuthState(conn.userId, conn.orgId)
  if (!ownerState || ownerState.status !== "active") {
    throw new Error("mcp connection owner not active")
  }

  // An external user reaches no agent and no tool, whoever created the row.
  const [owner] = await withSystemDb("mcp-conn-owner-type", (db) =>
    db.select({ userType: users.userType }).from(users).where(eq(users.id, conn.userId)),
  )
  if (owner?.userType !== "member") throw new Error("mcp connection owner is an external user")

  const perms = await withPrivilegedDb(conn.orgId, "mcp-conn-perms", (pdb) =>
    loadEffectivePermissions(pdb, conn.userId, conn.orgId),
  )

  // An agent-bound connection acts AS the agent: the token may carry no more
  // than the agent's live ceiling intersected with the grantor's live grants.
  // A legacy connection is untouched and still signs the grantor's own set.
  let scopes = perms.scopes
  if (conn.agentId) {
    const agent = await loadLiveAgent(conn.orgId, conn.agentId)
    if (!agent) throw new Error("mcp connection agent not available")
    scopes = intersectScopes(perms.scopes, agent.scopeCeiling)
  }

  const token = await signAccessToken(
    {
      userId: conn.userId,
      orgId: conn.orgId,
      name: "mcp",
      userType: owner.userType,
      // Use the owner's live auth/permission versions so that credential
      // revocations (password change, scope update) are reflected in MCP
      // tokens at next mint — matching the REST auth middleware behaviour.
      authVersion: ownerState.authVersion,
      permissionVersion: ownerState.permissionVersion,
      scopes,
      dimensionGrants: perms.dimensionGrants,
      mcpConnectionId: conn.id, // typed claim — requires the jwt.ts extension
      ...(conn.agentId ? { agentId: conn.agentId, grantorUserId: conn.userId } : {}),
    },
    env.JWT_SECRET,
    MCP_ACCESS_TOKEN_TTL_SECONDS,
  )

  await withSystemDb("mcp-conn-touch", (db) =>
    db
      .update(mcpConnections)
      // mintScopeSnapshot is an AUDIT record of what this mint handed out
      // (A10). It is never read back to authorize a request: every request
      // re-derives the set from the live grants and the live ceiling. Left
      // null on a legacy connection, which narrows nothing.
      .set({ lastUsedAt: new Date(), mintScopeSnapshot: conn.agentId ? scopes : null })
      .where(eq(mcpConnections.id, connectionId)),
  )

  return { token }
}

// `refresh_token` grant: the presented credential is `<connId>.<secret>`.
// Look up by id (O(1)), then constant-time compare the secret hash before
// minting. A bare connection id (no secret) can never mint a token.
export async function refreshAccessToken(refreshToken: string): Promise<{ token: string }> {
  const parsed = parseRefreshToken(refreshToken)
  if (!parsed) throw new Error("mcp invalid refresh token")
  const [conn] = await withSystemDb("mcp-conn-refresh-load", (db) =>
    db.select().from(mcpConnections).where(eq(mcpConnections.id, parsed.connectionId)),
  )
  if (!conn) throw new Error("mcp connection not found")
  if (conn.revokedAt) throw new Error("mcp connection revoked")
  if (await isDemoOrgExpiredNow(conn.orgId)) throw new Error("mcp demo workspace expired")
  if (await orgRefusesNonSessionCredentials(conn.orgId)) throw new Error("mcp org suspended")
  if (!secretMatches(parsed.secret, conn.refreshTokenHash)) {
    throw new Error("mcp refresh secret mismatch")
  }
  return mintAccessToken(conn.id)
}

export async function resolveConnectionFromToken(token: string): Promise<{
  connectionId: string
  userId: string
  orgId: string
  scopes: string[]
  dimensionGrants: Record<string, string[]>
  agentId?: string
}> {
  const payload = await verifyAccessToken(token, env.JWT_SECRET)
  const connectionId = payload.mcpConnectionId
  if (!connectionId) throw new Error("mcp token missing connection id")
  // A token minted before the demo workspace expired stops resolving with it.
  if (await isDemoOrgExpiredNow(payload.orgId)) throw new Error("mcp demo workspace expired")

  const [conn] = await withSystemDb("mcp-conn-resolve-load", (db) =>
    db.select().from(mcpConnections).where(eq(mcpConnections.id, connectionId)),
  )

  // EVERY connection, bound to an agent or not, is judged per request, never from the scopes baked
  // into the token. A LEGACY (unbound) connection used to trust the token's baked scopes for its whole
  // 15 minute life, so a revoked connection, a deactivated owner or a demoted role stayed fully usable
  // until the token expired. Now the authorized set is recomputed from the grantor's CURRENT grants
  // (and, when bound, the agent's CURRENT ceiling) on every call, and revocation closes the
  // connection on the very next call.
  if (!conn) throw new Error("mcp connection not found")
  if (conn.revokedAt) throw new Error("mcp connection revoked")
  // The token's agent claim and the connection's own binding must AGREE. A claim-less token for a
  // connection bound to an agent out of band, or the reverse, is an irresolvable disagreement
  // (the scopes below derive from the claim): refuse and let the client mint again.
  if ((conn.agentId ?? undefined) !== (payload.agentId ?? undefined)) {
    throw new Error("mcp connection agent binding changed")
  }
  // Grantor liveness, per request rather than at mint only: a connection acts with a human's
  // authority, so a deactivated, suspended or deleted grantor must stop it on the very next call,
  // not at the end of the token's TTL. Same getUserAuthState source as mint and the REST middleware.
  const ownerState = await getUserAuthState(conn.userId, conn.orgId)
  if (ownerState?.status !== "active") {
    throw new Error("mcp connection owner not active")
  }
  // A token minted before the owner's credentials changed (password change or reset, a second
  // factor turned off) is refused, as the REST middleware refuses one: the client refreshes, and
  // the refresh grant decides whether the connection still stands.
  if (payload.authVersion !== ownerState.authVersion) {
    throw new Error("mcp token predates a credential change")
  }
  if (!payload.agentId) {
    const legacyPerms = await withPrivilegedDb(conn.orgId, "mcp-conn-resolve-perms", (pdb) =>
      loadEffectivePermissions(pdb, conn.userId, conn.orgId),
    )
    // The authorized set is what the token was minted with, cut down to the grantor's CURRENT
    // grants: a demotion applies on the next call, and a recompute can never widen the token.
    return {
      connectionId,
      userId: conn.userId,
      orgId: conn.orgId,
      scopes: intersectScopes(payload.scopes ?? [], legacyPerms.scopes),
      dimensionGrants: legacyPerms.dimensionGrants,
    }
  }

  const agent = await loadLiveAgent(conn.orgId, payload.agentId)
  if (!agent) throw new Error("mcp connection agent not available")
  const perms = await withPrivilegedDb(conn.orgId, "mcp-conn-resolve-perms", (pdb) =>
    loadEffectivePermissions(pdb, conn.userId, conn.orgId),
  )
  return {
    connectionId,
    userId: conn.userId,
    orgId: conn.orgId,
    scopes: intersectScopes(perms.scopes, agent.scopeCeiling),
    dimensionGrants: perms.dimensionGrants,
    agentId: payload.agentId,
  }
}

/**
 * WHERE AN AGENT-BOUND MCP CONNECTION'S TURN TAINT LIVES.
 *
 * The decision, recorded verbatim: "the persisted MCP turn taint is keyed
 * `mcp:turn-taint:<orgId>:<agentId>`, because two connections bound to one
 * agent are the same external runtime as far as laundering goes and turn
 * boundaries are unknowable. Consequence: revoking ONE connection no longer
 * deletes the key (another connection for the agent may be live); the sliding
 * 15-minute expiry is the only clearing." The window stays
 * `MCP_ACCESS_TOKEN_TTL_SECONDS`, refreshed on every tools/call, and re-minting
 * does not clear it.
 *
 * This supersedes FX1-2's per-connection key. Keying by connection let an
 * external runtime launder around the check by simply opening a second
 * connection for the SAME agent: read there, write here, two untainted turns.
 * The agent is the unit an external runtime is bound to, so it is the unit the
 * taint follows.
 *
 * Why it cannot stay on the ctx: the streamable-HTTP transport is STATELESS, so
 * `transport-routes` rebuilds the `ToolCallCtx` on every POST and an in-memory
 * accumulator dies with the request. A scoped read in one `tools/call` followed
 * by an undeclared write in the next would then be judged as two untainted
 * turns, which is exactly the laundering path the in-app bridge refuses.
 */
/**
 * The id the taint window of a gateway call is kept under: its agent for an agent-bound
 * connection (the decision above), the connection itself for one bound to no agent
 * (scope-taint.ts, rule 14). Prefixed so it can never equal an agent id. Every window helper
 * below takes it where it says `agentId`.
 */
export function connectionTaintWindowId(ctx: { agentId?: string; connectionId: string }): string {
  return ctx.agentId ?? `connection:${ctx.connectionId}`
}

export function mcpTurnTaintKey(orgId: string, agentId: string): string {
  return `mcp:turn-taint:${orgId}:${agentId}`
}

/**
 * A TURN OPENS THE SET (fix8 M2). Run when a local session starts, when it
 * posts a turn, and when a node job is claimed or starts: the set is written
 * empty when it does not exist, for the window, and never overwritten. A
 * tagger that then finds NO set for a turn younger than the window knows the
 * set was lost (eviction, a flush), not that the turn read nothing, and falls
 * back to the conservative bound rather than stamping the reply empty. The
 * enforcement side reads `[]` exactly as it reads a missing key.
 */
export async function openConnectionTurnTaint(orgId: string, agentId: string): Promise<void> {
  await redis.set(mcpTurnTaintKey(orgId, agentId), "[]", "EX", MCP_ACCESS_TOKEN_TTL_SECONDS, "NX")
}

/** Whether the agent's taint set exists at all: absent is not empty to a tagger (fix8 M2). */
export async function connectionTurnTaintPresent(orgId: string, agentId: string): Promise<boolean> {
  return (await redis.exists(mcpTurnTaintKey(orgId, agentId))) === 1
}

/**
 * The scopes this agent's MCP turn has touched so far. A MISSING key is `[]`,
 * the positive "this runtime has touched nothing" that a never-written key
 * genuinely asserts. An UNREADABLE one is `UNKNOWN_TURN_TAINT` instead.
 *
 * The old `[]` on a parse failure under-reported: it made exactly the claim
 * "this turn touched no scoped data", which is the one claim nobody can make
 * about a value nobody could parse, and it admitted the next undeclared write.
 * The marker is non-empty, so `checkToolScopeTaint` reads a tainted turn and
 * refuses that write; it is not a real scope string, so nothing can mistake it
 * for one; and it still lets the turn answer, since the enforcing sinks and
 * readOnly tools pass on a tainted turn.
 *
 * A parsed array with a non-string element is the same case, not a filterable
 * one: silently dropping the bad entries turns a set nobody could read into a
 * shorter set somebody might act on, and an all-bad array into an empty one.
 */
export async function loadConnectionTurnTaint(
  orgId: string,
  agentId: string,
  opts: { dropIdleScopes?: boolean } = {},
): Promise<string[]> {
  const raw = await redis.get(mcpTurnTaintKey(orgId, agentId))
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [...UNKNOWN_TURN_TAINT]
  }
  if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== "string")) {
    return [...UNKNOWN_TURN_TAINT]
  }
  const scopes = parsed as string[]
  if (!opts.dropIdleScopes) return scopes
  // PER-SCOPE IDLE EXPIRY (2026-09-22). The set's own window slides on EVERY call, so a
  // runtime that read one scoped figure and then kept working (reads, searches, anything)
  // stayed tainted by it for as long as it kept talking: poisoned for the whole session.
  // A scope now leaves the set once it has gone a full window without being read again,
  // which is the same heuristic the set's expiry already stood for ("turn boundaries are
  // unknowable, so a window stands in for one"), applied per scope instead of to the whole
  // set. A scope with no stamp (written before the stamps existed, or the unknown-taint
  // marker, which no read ever records) is kept: the conservative answer.
  const touched = await redis.hgetall(mcpTurnTaintTouchedKey(orgId, agentId))
  const now = Date.now()
  const windowMs = MCP_ACCESS_TOKEN_TTL_SECONDS * 1000
  return scopes.filter((scope) => {
    const at = Number(touched?.[scope])
    return !(Number.isFinite(at) && now - at > windowMs)
  })
}

/** Replace the agent's accumulated set and refresh the sliding window. */
export async function saveConnectionTurnTaint(
  orgId: string,
  agentId: string,
  scopes: string[],
): Promise<void> {
  await redis.set(
    mcpTurnTaintKey(orgId, agentId),
    JSON.stringify(scopes),
    "EX",
    MCP_ACCESS_TOKEN_TTL_SECONDS,
  )
  // The per-scope stamps live exactly as long as the set they describe; without this a
  // taint-free call would let the stamps expire under a still-live set, and an unstamped
  // scope is kept forever by the loader above.
  await redis.expire(mcpTurnTaintTouchedKey(orgId, agentId), MCP_ACCESS_TOKEN_TTL_SECONDS)
}

/**
 * When each scope in the agent's taint set was last READ (not first: that is the marks
 * hash below, which serves tagging). The enforcement loader drops a scope a full window
 * after its last read.
 */
export function mcpTurnTaintTouchedKey(orgId: string, agentId: string): string {
  return `mcp:turn-taint-touched:${orgId}:${agentId}`
}

/** Stamp the scopes one call just read with the current time. */
export async function touchConnectionTaintScopes(
  orgId: string,
  agentId: string,
  scopes: readonly string[],
): Promise<void> {
  if (scopes.length === 0) return
  const key = mcpTurnTaintTouchedKey(orgId, agentId)
  const now = String(Date.now())
  const pipeline = redis.pipeline()
  for (const scope of scopes) pipeline.hset(key, scope, now)
  pipeline.expire(key, MCP_ACCESS_TOKEN_TTL_SECONDS)
  await pipeline.exec()
}

/**
 * WHERE THIS RUNTIME'S SCOPED READS CAME FROM (P6d-FX10).
 *
 * The same-resource allowance (A46) lets a tainted turn write back to a row it
 * READ and to no other. It is judged against the origin rows the turn filed,
 * and those lived only in the per-request accumulator while the taint's SCOPES
 * were persisted above. Over a stateless transport that is the whole allowance
 * gone: an external runtime reads a ticket in one POST and replies in the next,
 * the reply is judged against no origins at all, and the write is refused
 * before it can even stage its approval. The two halves of one rule have to
 * cross the same hop, so the rows are persisted beside the scopes, keyed the
 * same way and expiring on the same sliding window.
 *
 * Keyed per (org, agent) for the reason the scope set is: two connections bound
 * to one agent are one external runtime. The direction is symmetric, too: that
 * key already taints this runtime with everything it touched in the window, so
 * judging it against everything it READ in the same window is the matching
 * half, never a wider one.
 *
 * FAILS CLOSED. An unreadable or malformed value yields NO origins, which
 * allows nothing: the write is refused exactly as it is today.
 */
export function mcpTurnTaintOriginsKey(orgId: string, agentId: string): string {
  return `mcp:turn-taint-origins:${orgId}:${agentId}`
}

/** The rows this runtime has read, by table. `{}` when there are none to trust. */
export async function loadConnectionTurnTaintOrigins(
  orgId: string,
  agentId: string,
): Promise<TaintOriginRows> {
  const raw = await redis.get(mcpTurnTaintOriginsKey(orgId, agentId))
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, string[]> = {}
    for (const [table, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return {}
      out[table] = ids as string[]
    }
    return out
  } catch {
    return {}
  }
}

/** Replace the agent's origin rows and refresh the sliding window. */
export async function saveConnectionTurnTaintOrigins(
  orgId: string,
  agentId: string,
  origins: TaintOriginRows,
): Promise<void> {
  await redis.set(
    mcpTurnTaintOriginsKey(orgId, agentId),
    JSON.stringify(origins),
    "EX",
    MCP_ACCESS_TOKEN_TTL_SECONDS,
  )
}

/**
 * WHEN EACH SCOPE ENTERED THE RUNTIME (P8-FX2, SK-1).
 *
 * The key above is a cumulative SET with a sliding 15 minute window, and it is
 * deliberately never cleared: turn boundaries are unknowable over a stateless
 * transport, so anything this agent's external runtime touched inside the
 * window taints the next undeclared write. That is right for REFUSING a write
 * and wrong for TAGGING a message: folding the whole set into a locally run
 * reply let a call made 14 minutes earlier, in another conversation, tag an
 * answer with a scope it never touched, and a reader without that scope (the
 * person who ASKED, in the reported case) then gets the hidden marker instead
 * of their answer.
 *
 * So the same writes also record WHEN each scope first appeared, in a hash
 * beside the set. A tagger that knows when the turn it is tagging began can
 * then fold in only what that turn brought in. Nothing reads this hash to
 * refuse anything: the cumulative set remains the enforcement input, unchanged.
 *
 * First touch, not last: `hsetnx` leaves an existing stamp alone, so a scope
 * that entered before the turn cannot be re-dated into it by a later call.
 */
export function mcpTurnTaintMarksKey(orgId: string, agentId: string): string {
  return `mcp:turn-taint-marks:${orgId}:${agentId}`
}

/** Stamp each newly touched scope with its first-touch time and slide the window. */
export async function recordConnectionTaintMarks(
  orgId: string,
  agentId: string,
  scopes: readonly string[],
): Promise<void> {
  if (scopes.length === 0) return
  const key = mcpTurnTaintMarksKey(orgId, agentId)
  const now = Date.now()
  const pipeline = redis.pipeline()
  for (const scope of scopes) pipeline.hsetnx(key, scope, String(now))
  pipeline.expire(key, MCP_ACCESS_TOKEN_TTL_SECONDS)
  await pipeline.exec()
}

/**
 * Every scope this agent's runtime has touched inside the window, with its
 * first-touch time. `null` means the marks cannot be trusted: a stamp that is
 * not a number is the same case as an unparsable taint set, and a caller must
 * fall back to the conservative answer rather than to a shorter one.
 */
export async function loadConnectionTaintMarks(
  orgId: string,
  agentId: string,
): Promise<Map<string, number> | null> {
  const raw = await redis.hgetall(mcpTurnTaintMarksKey(orgId, agentId))
  const out = new Map<string, number>()
  for (const [scope, at] of Object.entries(raw ?? {})) {
    const ms = Number(at)
    if (!Number.isFinite(ms)) return null
    out.set(scope, ms)
  }
  return out
}

/**
 * WHAT A LONG LOCAL TURN READ, PAST THE WINDOW (2026-10-08).
 *
 * The set and marks above expire a window (15 minutes) after the runtime's last call, so a
 * local turn that read a scoped figure and then worked for twenty minutes without calling
 * Liaison would find nothing of that read when its reply is tagged. The tag used to be covered
 * by the turn's whole effective scope; it is now what the turn read (local-context-scopes.ts),
 * so the read has to survive the turn. This ledger keeps, per scope, when the runtime last read
 * it, for a day. Only the tagger reads it, and only for a turn older than the window; nothing
 * refuses on it, so it never widens the enforcement set.
 */
export const MCP_TAINT_LEDGER_TTL_SECONDS = 24 * 60 * 60

export function mcpTurnTaintLedgerKey(orgId: string, agentId: string): string {
  return `mcp:turn-taint-ledger:${orgId}:${agentId}`
}

/** Stamp the scopes one call read with the current time, kept for the ledger's day. */
export async function recordConnectionTaintLedger(
  orgId: string,
  agentId: string,
  scopes: readonly string[],
): Promise<void> {
  if (scopes.length === 0) return
  const key = mcpTurnTaintLedgerKey(orgId, agentId)
  const now = String(Date.now())
  const pipeline = redis.pipeline()
  for (const scope of scopes) pipeline.hset(key, scope, now)
  pipeline.expire(key, MCP_TAINT_LEDGER_TTL_SECONDS)
  await pipeline.exec()
}

/** Each scope's last-read time in the ledger; `null` when a stamp is not a number. */
export async function loadConnectionTaintLedger(
  orgId: string,
  agentId: string,
): Promise<Map<string, number> | null> {
  const raw = await redis.hgetall(mcpTurnTaintLedgerKey(orgId, agentId))
  const out = new Map<string, number>()
  for (const [scope, at] of Object.entries(raw ?? {})) {
    const ms = Number(at)
    if (!Number.isFinite(ms)) return null
    out.set(scope, ms)
  }
  return out
}

export async function revokeConnection(
  connectionId: string,
  requesterUserId: string,
): Promise<void> {
  const [row] = await withSystemDb("mcp-conn-revoke", (db) =>
    db
      .update(mcpConnections)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(mcpConnections.id, connectionId),
          eq(mcpConnections.userId, requesterUserId),
          isNull(mcpConnections.revokedAt),
        ),
      )
      .returning(),
  )
  if (!row) throw new Error("mcp connection not found or not owned by requester")
  // The turn taint is NOT cleared here any more (see mcpTurnTaintKey). It is
  // keyed by agent, and another connection bound to the same agent may still be
  // live, so deleting it on one connection's revoke would hand that live runtime
  // a clean slate it did not earn. The sliding 15-minute idle expiry is the only
  // clearing, and the revoked connection itself can no longer call anything.
}

// Load the per-connection discovered deferred-tool sdk-names (spec C4 /
// criterion 3). A fresh stateless reconnect rehydrates this so tools/list
// still includes tools surfaced earlier via liaison_tool_search.
export async function loadDiscoveredTools(connectionId: string): Promise<string[]> {
  const [conn] = await withSystemDb("mcp-conn-discovered-load", (db) =>
    db
      .select({ discoveredTools: mcpConnections.discoveredTools })
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId)),
  )
  return conn?.discoveredTools ?? []
}

// Persist newly discovered deferred tools for a connection (union with the
// existing set). Called by liaison_tool_search so the discovery survives the
// stateless reconnect (spec C4).
export async function addDiscoveredTools(connectionId: string, sdkNames: string[]): Promise<void> {
  if (sdkNames.length === 0) return
  await withSystemDb("mcp-conn-discovered-add", async (db) => {
    const [conn] = await db
      .select({ discoveredTools: mcpConnections.discoveredTools })
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId))
    if (!conn) return
    const merged = Array.from(new Set([...conn.discoveredTools, ...sdkNames]))
    if (merged.length === conn.discoveredTools.length) return
    await db
      .update(mcpConnections)
      .set({ discoveredTools: merged })
      .where(eq(mcpConnections.id, connectionId))
  })
}

// Load the set of skills whose body has ALREADY been pushed to this connection
// via an app-anchored tool result. Rehydrated per stateless request so the push
// stays exactly-once across reconnects instead of repeating on every call.
export async function loadSurfacedSkills(connectionId: string): Promise<string[]> {
  const [conn] = await withSystemDb("mcp-conn-surfaced-load", (db) =>
    db
      .select({ surfacedSkills: mcpConnections.surfacedSkills })
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId)),
  )
  return conn?.surfacedSkills ?? []
}

// Record that a skill's body has been pushed to this connection (union with the
// existing set). Best-effort: a failure here re-surfaces the skill on a later
// call, which is redundant but harmless — never a reason to fail the tool call.
export async function addSurfacedSkills(connectionId: string, names: string[]): Promise<void> {
  if (names.length === 0) return
  await withSystemDb("mcp-conn-surfaced-add", async (db) => {
    const [conn] = await db
      .select({ surfacedSkills: mcpConnections.surfacedSkills })
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId))
    if (!conn) return
    const merged = Array.from(new Set([...conn.surfacedSkills, ...names]))
    if (merged.length === conn.surfacedSkills.length) return
    await db
      .update(mcpConnections)
      .set({ surfacedSkills: merged })
      .where(eq(mcpConnections.id, connectionId))
  })
}

// Active connections only — Settings → MCP treats the list as active
// connections (spec C6). Revoked rows are excluded so the UI never offers a
// Revoke action that would 404 against the isNull(revokedAt) revoke guard.
export async function listConnectionsForUser(orgId: string, userId: string) {
  return withSystemDb("mcp-conn-list", (db) =>
    db
      .select()
      .from(mcpConnections)
      .where(
        and(
          eq(mcpConnections.orgId, orgId),
          eq(mcpConnections.userId, userId),
          isNull(mcpConnections.revokedAt),
        ),
      ),
  )
}
