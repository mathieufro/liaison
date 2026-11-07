// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, count, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm"
import type { StatusCode } from "hono/utils/http-status"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import {
  invitations,
  organizations,
  roleDimensionGrants,
  sessions,
  userRoles,
  users,
} from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { generateToken, hashPassword, hashToken, verifyPassword } from "~/lib/crypto"
import { env } from "~/lib/env"
import { authLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { issueToken as issueRedisToken } from "~/lib/token-store"
import { initOrgCredits } from "~/modules/agent/credits/credit-service"
import { ensureBaseAgentTx } from "~/modules/agent/directory/base-agent"
import { createPersonalAgent } from "~/modules/agent/directory/personal-agent"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { adminSecondFactorPending, holdsAdminScope } from "~/modules/auth/admin-second-factor"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { ensureGoogleLoginProvider } from "~/modules/auth/google-login-provider"
import { signAccessToken, signPortalToken } from "~/modules/auth/jwt"
import { applyScopeCeiling } from "~/modules/auth/session-ceiling"
import { revokeSessions } from "~/modules/auth/session-revocation"
import { assertOrgSessionAllowed, SUSPENDED_ADMIN_SCOPE } from "~/modules/cloud/suspension"
import { assertDemoOrgActive } from "~/modules/demo/demo-expiry"
import { revokeAllMcpConnectionsForUser } from "~/modules/mcp/end-user-connections"
import { assertSeatRoom } from "~/modules/org/caps"
import { assertOrgAcceptsWrites, withOrgWrite } from "~/modules/org/transfer-state/gate"
import { beginOrgActivity } from "~/modules/org/transfer-state/state"
import { seedDefaultRoles } from "~/modules/permissions/default-roles"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"
import { startSetupKickoff } from "~/modules/provisioning/setup-kickoff"
import { removeAllPushDeliveryForUser } from "~/modules/push/end-user-push"

interface TokenPair {
  accessToken: string
  refreshToken: string
  orgId: string
  userId: string
  /** The account holds an administrative scope (admin-second-factor.ts). Never sent to a client. */
  admin: boolean
}

// Pre-compute dummy hash at module load for constant-time login responses.
// Prevents timing oracle that leaks user existence (password hash only runs when user exists).
const DUMMY_HASH = await hashPassword("__timing_safe_dummy__")

/** The presented refresh token names no live session (unknown, expired or consumed). */
export class InvalidSessionError extends Error {
  constructor() {
    super("Invalid session")
    this.name = "InvalidSessionError"
  }
}

/**
 * The refresh token's successor was issued a moment ago by a concurrent refresh
 * of the same client (refreshSession, REFRESH_RACE_MS), or a concurrent issue
 * won. Nothing is issued; the cookie already holds the rotated token, so the
 * caller retries instead of signing out.
 */
export class RefreshRaceError extends Error {
  constructor() {
    super("Refresh token was rotated by a concurrent refresh")
    this.name = "RefreshRaceError"
  }
}

export class AuthServiceError extends Error {
  constructor(
    message: string,
    readonly status: StatusCode,
  ) {
    super(message)
    this.name = "AuthServiceError"
  }
}

export async function isBootstrapped(): Promise<boolean> {
  const result = await withSystemDb("bootstrap-check", (db) =>
    db.select().from(organizations).limit(1),
  )
  return result.length > 0
}

export async function bootstrapRegister(
  email: string,
  password: string | undefined,
  name: string,
): Promise<TokenPair> {
  // Passwordless-first: the primary flow creates the first user with no password
  // (they sign in via magic link). A password is hashed only when explicitly
  // supplied (opting into the retained password login path).
  const passwordHash = password ? await hashPassword(password) : null

  const { userId, orgId } = await withSystemDb("bootstrap-register", async (tx) => {
    // Advisory lock prevents concurrent bootstrap attempts (TOCTOU race)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7301948265)`)

    // Re-check inside the lock
    const [existing] = await tx.select().from(organizations).limit(1)
    if (existing) {
      throw new AuthServiceError("Already bootstrapped", 409)
    }

    // Create org
    const [org] = await tx
      .insert(organizations)
      .values({
        name: "Default Organization",
        slug: "default",
      })
      .returning()

    // Seed default role presets — owner ("admin") gets full access; "member" and
    // "viewer" exist as starting presets the org admin can apply to teammates.
    const adminRole = await seedDefaultRoles(tx, org.id)
    await tx
      .insert(roleDimensionGrants)
      .values({ roleId: adminRole.id, dimensionKey: "*", dimensionValues: ["*"] })

    // Create user
    const [user] = await tx
      .insert(users)
      .values({
        orgId: org.id,
        email: email.toLowerCase(),
        passwordHash,
        name,
        status: "active",
      })
      .returning()

    // Assign admin role
    await tx.insert(userRoles).values({ userId: user.id, roleId: adminRole.id, orgId: org.id })

    // Give the first user a personal agent immediately. Its scope ceiling
    // reads the grants just assigned above, so it must run after the admin
    // role insert, inside this same transaction.
    await createPersonalAgent(tx, {
      orgId: org.id,
      userId: user.id,
      email: user.email,
      firstName: name.split(" ")[0],
    })

    // Every org also gets its `@base` system agent at bootstrap (spec-agents.md):
    // the shared org-wide capability surface every personal/role agent can draw
    // on via agent_skill_index, and the routing fallback when no named agent
    // claims a capability. Uses the already-open transaction directly
    // (ensureBaseAgentTx), not `ensureBaseAgent`'s own `withPrivilegedDb`, which
    // would nest a second pool-acquiring transaction inside this one.
    await ensureBaseAgentTx(tx, org.id)

    // Initialize credit balance for the new org
    await initOrgCredits(org.id, "EUR", "20.00000000", tx)

    log.info({ userId: user.id, orgId: org.id }, "Bootstrap: first user and org created")

    return { userId: user.id, orgId: org.id }
  })

  // Post-transaction: initialize the org runtime and seed defaults.
  // Both operations are idempotent — a failure here does not corrupt the committed
  // org/user row, and the session is still issued so the user can proceed.
  // A partial failure will be retried on the next org access via the lazy init path.
  try {
    // New orgs are often created after the server has already started in dev/QA bootstrapping,
    // so initialize the org runtime immediately instead of waiting for process restart.
    await ensureAppsForOrg(orgId)

    // Seed the first-party Google login provider (no-op unless GOOGLE_OAUTH_* is set),
    // so "Continue with Google" works for this org without a restart.
    await ensureGoogleLoginProvider(orgId)

    // Seed manifest-declared default saved views for the newly bootstrapped org.
    // ensureAppsForOrg() populates manifestRegistry, so savedViews are visible.
    const { seedManifestDefaults } = await import("~/modules/saved-views/seed")
    const { withPrivilegedDb: withPrivDb } = await import("~/db/privileged")
    await withPrivDb(orgId, "bootstrap-saved-views-seed", (tx) => seedManifestDefaults(tx, orgId))
  } catch (err) {
    log.error(
      { err, orgId },
      "Bootstrap post-init failed — org is registered but runtime setup incomplete; will retry on next access",
    )
  }

  return createSession(userId, orgId)
}

type InviteResult = { success: true; data: TokenPair } | { success: false; error: string }

export async function inviteRegister(
  inviteToken: string,
  password: string | undefined,
  name: string,
): Promise<InviteResult> {
  const tokenHash = hashToken(inviteToken)

  let txResult: { success: false; error: string } | { success: true; userId: string; orgId: string }
  try {
    txResult = await inviteRegisterTx(tokenHash, password, name)
  } catch (err) {
    if (err instanceof InviteEmailTakenError) {
      return { success: false as const, error: "Email already registered" }
    }
    throw err
  }

  if (!txResult.success) return txResult
  const tokens = await createSession(txResult.userId, txResult.orgId)
  return { success: true as const, data: tokens }
}

class InviteEmailTakenError extends Error {}

function inviteRegisterTx(tokenHash: string, password: string | undefined, name: string) {
  return withSystemDb("invite-register", async (tx) => {
    // Atomic claim: mark invite as accepted only if still unused and not expired.
    // Prevents race where two concurrent registrations both see acceptedAt = null.
    const [invite] = await tx
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(invitations.tokenHash, tokenHash),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .returning()

    if (!invite) return { success: false as const, error: "Invalid or expired invitation" }

    // Passwordless-first: the invite token already proves email ownership, so the
    // user is created without a password unless one is explicitly supplied. It is
    // hashed only once a live invite is claimed, so a junk token costs no hash.
    const passwordHash = password ? await hashPassword(password) : null

    // The org's seat cap (modules/org/caps.ts): counted and taken under the
    // org's seats lock, in this transaction, so two accepts of the last seat
    // get one seat. A refusal rolls the claim back: the invite stays usable.
    await assertSeatRoom(tx, invite.orgId)

    // Create user with email from invitation
    let user: typeof users.$inferSelect
    try {
      ;[user] = await tx
        .insert(users)
        .values({
          orgId: invite.orgId,
          email: invite.email.toLowerCase(),
          passwordHash,
          name,
          status: "active",
          invitedBy: invite.invitedBy,
        })
        .returning()
    } catch (err: any) {
      // The email is taken in this org. Rethrow a sentinel so the transaction ROLLS
      // BACK (the invite claim above is undone, the invite stays usable) instead of
      // returning on an aborted transaction. Drizzle wraps the postgres error, so the
      // SQLSTATE sits on `.cause`.
      if ((err?.code ?? err?.cause?.code) === "23505") throw new InviteEmailTakenError()
      throw err
    }

    // Assign role from invitation
    await tx
      .insert(userRoles)
      .values({ userId: user.id, roleId: invite.roleId, orgId: invite.orgId })

    // Invitation already marked as accepted by the atomic UPDATE above

    // Give the invited user a personal agent immediately. Its scope ceiling
    // reads the grants the role assignment above just conferred, so this must
    // run after that insert, inside this same transaction.
    await createPersonalAgent(tx, {
      orgId: invite.orgId,
      userId: user.id,
      email: user.email,
      firstName: name.split(" ")[0],
    })

    log.info({ userId: user.id, email: invite.email }, "User registered via invitation")

    return { success: true as const, userId: user.id, orgId: invite.orgId }
  })
}

export async function login(
  email: string,
  password: string,
  orgSlug?: string,
): Promise<TokenPair | { totpRequired: true; challengeToken: string }> {
  // Select only the columns needed for login — never load totpSecret/recoveryCodes into memory
  const loginCols = {
    id: users.id,
    orgId: users.orgId,
    status: users.status,
    passwordHash: users.passwordHash,
    totpEnabled: users.totpEnabled,
  }

  let matches: {
    id: string
    orgId: string
    status: string
    passwordHash: string | null
    totpEnabled: boolean
  }[]

  if (orgSlug) {
    const orgRow = await withSystemDb("login-org-lookup", (db) =>
      db.select().from(organizations).where(eq(organizations.slug, orgSlug)).limit(1),
    )
    if (!orgRow[0]) {
      // Org not found — run dummy hash to prevent timing oracle that leaks org existence
      await verifyPassword(password, DUMMY_HASH)
      throw new AuthServiceError("Invalid credentials", 401)
    }
    matches = await withSystemDb("login-user-lookup", (db) =>
      db
        .select(loginCols)
        .from(users)
        .where(and(eq(users.email, email.toLowerCase()), eq(users.orgId, orgRow[0].id)))
        .limit(1),
    )
  } else {
    matches = await withSystemDb("login-email-lookup", (db) =>
      db.select(loginCols).from(users).where(eq(users.email, email.toLowerCase())).limit(2),
    )
    if (matches.length > 1) {
      // Uniform error + timing parity prevents multi-org email enumeration
      await verifyPassword(password, DUMMY_HASH)
      throw new AuthServiceError("Invalid credentials", 401)
    }
  }

  const user = matches[0]
  if (!user) {
    // Constant-time: run bcrypt against dummy hash to prevent timing oracle
    // that would reveal whether the email exists in the system
    await verifyPassword(password, DUMMY_HASH)
    throw new AuthServiceError("Invalid credentials", 401)
  }
  if (user.status !== "active") {
    // Uniform error + timing parity prevents account status enumeration
    await verifyPassword(password, DUMMY_HASH)
    throw new AuthServiceError("Invalid credentials", 401)
  }

  if (!user.passwordHash) {
    await verifyPassword(password, DUMMY_HASH)
    throw new AuthServiceError("Invalid credentials", 401)
  }

  const valid = await verifyPassword(password, user.passwordHash)
  if (!valid) throw new AuthServiceError("Invalid credentials", 401)

  if (user.totpEnabled) {
    // Redis-backed single-use challenge token.
    // Replaces signed JWT to guarantee single-use via atomic GETDEL on verify.
    const challengeToken = await issueRedisToken(redis, "challenge", { userId: user.id }, 300)
    return { totpRequired: true, challengeToken }
  }

  return createSession(user.id, user.orgId)
}

/**
 * @param scopeCeiling When provided, the session is RESTRICTED: the issued
 *   access token's scopes are intersected with this set, and the set is stored
 *   on the session row (`scope_ceiling`) so every later refresh applies it too.
 *   Pass `undefined` for a full-permission session. Used by the device flow to
 *   honour the `scopes` declared on the flow request, and by refreshSession to
 *   carry a restricted session's ceiling onto its rotated successor.
 */
export async function createSession(
  userId: string,
  orgId: string,
  scopeCeiling?: string[],
  rotation?: SessionRotation,
): Promise<TokenPair> {
  // A session row is a write of the org: counted, then refused while the org is
  // frozen or moved (503 `org_moving`; the client retries, and its token still
  // works on the new instance).
  return withOrgWrite(orgId, () => createSessionUnder(userId, orgId, scopeCeiling, rotation))
}

async function createSessionUnder(
  userId: string,
  orgId: string,
  scopeCeiling?: string[],
  rotation?: SessionRotation,
): Promise<TokenPair> {
  // The one door every login, token refresh, OAuth sign-in and magic link goes
  // through: an expired demo workspace mints no new credential (403).
  await assertDemoOrgActive(orgId)
  const refreshToken = generateToken()
  const refreshTokenHash = hashToken(refreshToken)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
  // A fresh sign-in starts its own family; a rotation continues its
  // predecessor's (refreshSession).
  const sessionId = crypto.randomUUID()
  // Sessions this transaction ends (a replaced successor, evictions past the
  // cap): their access tokens are revoked once it commits.
  const endedIds: string[] = []

  const { user, permissions, secondFactorPending, admin } = await withPrivilegedDb(
    orgId,
    "create-session",
    async (tx) => {
      // Every sign-in path ends here (password, magic link, TOTP, OAuth, device
      // flow, refresh), so this is where an account that is not active is refused,
      // under a row lock against a concurrent deactivation, before any session row
      // exists. Locked first, so the lock order (user, then sessions) is the one
      // deactivation takes too. A path that forgets its own status check still
      // mints nothing.
      const [u] = await tx
        .select({
          name: users.name,
          status: users.status,
          authVersion: users.authVersion,
          permissionVersion: users.permissionVersion,
          userType: users.userType,
        })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
        .for("update")
      if (!u || u.status !== "active") throw new AuthServiceError("Invalid credentials", 401)

      // A lost-response reissue replaces the successor its client never
      // received, in the same transaction that inserts the new one, and only
      // while that successor is still unused: a request it authenticated (or
      // its own refresh) since refreshSession checked it turns this into the
      // race answer, with nothing changed.
      if (rotation?.replaceSuccessorId) {
        const replaced = await tx
          .delete(sessions)
          .where(
            and(
              eq(sessions.id, rotation.replaceSuccessorId),
              isNull(sessions.usedAt),
              eq(sessions.isGrace, false),
            ),
          )
          .returning({ id: sessions.id })
        if (replaced.length === 0) throw new RefreshRaceError()
        endedIds.push(rotation.replaceSuccessorId)
      }

      // Evict oldest sessions if user has too many (SEC: session cap).
      // Lock all user sessions with FOR UPDATE first to prevent concurrent logins
      // both reading count=9 and both inserting, exceeding the cap.
      //
      // The cap counts LIVE sessions only. A refresh leaves its predecessor as a
      // 30 s grace row, and expired rows were never cleared: counted, they made
      // a phone that refreshes on every foreground evict the oldest row, which
      // was the user's desktop session, signing it out (demo, P1-T12). Expired
      // rows go first; grace rows still in their 30 s are neither counted nor
      // evicted.
      const MAX_SESSIONS_PER_USER = 10
      const now = new Date()
      await tx
        .delete(sessions)
        .where(and(eq(sessions.userId, userId), lte(sessions.expiresAt, now)))
      const existingSessions = await tx
        .select({ id: sessions.id, createdAt: sessions.createdAt })
        .from(sessions)
        .where(and(eq(sessions.userId, userId), eq(sessions.isGrace, false)))
        .orderBy(sessions.createdAt)
        .for("update")
      if (existingSessions.length >= MAX_SESSIONS_PER_USER) {
        const toEvict = existingSessions.slice(
          0,
          existingSessions.length - MAX_SESSIONS_PER_USER + 1,
        )
        await tx.delete(sessions).where(
          inArray(
            sessions.id,
            toEvict.map((s) => s.id),
          ),
        )
        for (const s of toEvict) endedIds.push(s.id)
      }

      await tx.insert(sessions).values({
        id: sessionId,
        orgId,
        userId,
        refreshTokenHash,
        expiresAt,
        scopeCeiling: scopeCeiling ?? null,
        familyId: rotation?.familyId ?? sessionId,
      })
      // Link the successor onto its predecessor, compare-and-set on the stamp
      // refreshSession wrote when it decided to issue: if anything re-decided
      // since (a reissue after this one stalled, a family revocation), this
      // issue loses and rolls back, so a predecessor never has two successors.
      if (rotation) {
        const linked = await tx
          .update(sessions)
          .set({ successorId: sessionId })
          .where(
            and(
              eq(sessions.id, rotation.predecessorId),
              eq(sessions.successorIssuedAt, rotation.stamp),
            ),
          )
          .returning({ id: sessions.id })
        if (linked.length === 0) throw new RefreshRaceError()
      }
      const perms = await loadEffectivePermissions(tx, userId, orgId)
      // A managed org suspended for billing: only its admins sign in (to export
      // and pay), nobody once closed (modules/cloud/suspension.ts). Thrown in
      // the transaction, so no session row is left behind. A no-op, without a
      // query, on a self-hosted instance.
      await assertOrgSessionAllowed(
        orgId,
        hasScope(SUSPENDED_ADMIN_SCOPE, perms.scopes) &&
          (scopeCeiling === undefined || hasScope(SUSPENDED_ADMIN_SCOPE, scopeCeiling)),
        tx,
      )
      const pending = await adminSecondFactorPending(tx, userId, orgId, perms.scopes)

      return {
        user: u,
        permissions: perms,
        secondFactorPending: pending,
        admin: u.userType !== "external" && holdsAdminScope(orgId, perms.scopes),
      }
    },
  )
  revokeSessions(endedIds, rotation ? "refresh-reissue" : "session-cap")

  // An administrator the org requires a second factor of, without one: a
  // session that can only enroll (admin-second-factor.ts). A device-flow
  // session in that state gets nothing at all: enrollment is for a person at
  // a sign-in screen, not a headless client.
  if (secondFactorPending) {
    const accessToken = await signSessionToken({ userId, orgId, sid: sessionId }, user, {
      roles: [],
      scopes: [],
      dimensionGrants: {},
      restricted: true,
      ...(scopeCeiling === undefined ? { secondFactorRequired: true } : {}),
    })
    return { accessToken, refreshToken, orgId, userId, admin }
  }

  // A restricted session (device flow) never carries more than its ceiling,
  // whatever the user's own permissions are now.
  const effectiveScopes = applyScopeCeiling(permissions.scopes, scopeCeiling)

  const accessToken = await signSessionToken({ userId, orgId, sid: sessionId }, user, {
    roles: permissions.roles,
    scopes: effectiveScopes,
    dimensionGrants: permissions.dimensionGrants,
    // A restricted session mints no further credential (session-ceiling.ts).
    ...(scopeCeiling !== undefined ? { restricted: true } : {}),
  })

  // A full administrator session may open a brand-new workspace's setup
  // conversation (provisioning/setup-kickoff.ts). Not awaited and never
  // throws: sign-in does not wait for it and cannot fail because of it.
  if (admin && scopeCeiling === undefined) startSetupKickoff({ orgId, userId, admin })

  return { accessToken, refreshToken, orgId, userId, admin }
}

/**
 * The token of a session, chosen by the row's type as this transaction read it,
 * never by a prior token: an external user's is a portal token, which carries no
 * grants whatever the row holds. Each mint site below goes through here.
 */
function signSessionToken(
  session: { userId: string; orgId: string; sid: string },
  user:
    | { name: string; authVersion: number; permissionVersion: number; userType: string }
    | undefined,
  grants: {
    roles: string[]
    scopes: string[]
    dimensionGrants: Record<string, string[]>
    restricted?: boolean
    secondFactorRequired?: boolean
  },
): Promise<string> {
  const identity = {
    ...session,
    name: user?.name ?? "Unknown",
    authVersion: user?.authVersion ?? 1,
    permissionVersion: user?.permissionVersion ?? 1,
  }
  if (user?.userType === "external") return signPortalToken(identity, env.JWT_SECRET)
  return signAccessToken({ ...identity, ...grants, userType: user?.userType }, env.JWT_SECRET)
}

/**
 * A refresh-token rotation, as createSession continues it: the predecessor
 * row, its family, the stamp refreshSession wrote when it decided to issue
 * (createSession links the successor only while the stamp is unchanged), and
 * for a lost-response reissue the unused successor being replaced.
 */
export interface SessionRotation {
  predecessorId: string
  familyId: string
  stamp: Date
  replaceSuccessorId: string | null
}

/**
 * A rotated refresh token presented in under this long since its successor was
 * issued is a concurrent refresh of the same client (two tabs sharing the
 * cookie, a retry racing its own first attempt): the race answer, nothing
 * issued, nothing revoked. Unchanged from the grace row this replaced.
 */
export const REFRESH_RACE_MS = 30_000

/**
 * How long after a rotation its client may still claim a response it never
 * received (see refreshSession). Three minutes: long enough to ride out a
 * tunnel or a dead cell on a train, during which the client retries the
 * refresh on every request it attempts, and short enough that a stolen spent
 * token is only worth anything for minutes, and then only while its rightful
 * client has not used the successor, which a client that got the response
 * does at once (the refresh exists to resend the request that met a 401).
 */
export const LOST_RESPONSE_WINDOW_MS = 3 * 60_000

/**
 * How long a rotated row is kept after its rotation, so a later replay of its
 * token is recognised as a reuse (and revokes the family) rather than an
 * unknown token. Rows are swept by createSession and the nightly cleanup.
 */
export const ROTATED_ROW_RETENTION_MS = 24 * 60 * 60_000

/**
 * A rotated refresh token was presented after its successor was used, by a
 * different client, or past the lost-response window: treated as stolen, and
 * every session of its family has been revoked. Answers like any dead token.
 */
export class RefreshReuseError extends InvalidSessionError {
  constructor(readonly reason: string) {
    super()
    this.name = "RefreshReuseError"
  }
}

type RefreshDecision =
  | { kind: "invalid"; reason: string }
  | { kind: "race" }
  | { kind: "reuse"; reason: string }
  | {
      kind: "issue"
      grace: boolean
      userId: string
      orgId: string
      scopeCeiling: string[] | null
      rotation: SessionRotation
    }

/**
 * Rotates a refresh token: the presented session is spent and a successor in
 * the same family is issued.
 *
 * WHY A SPENT TOKEN CAN STILL BE ANSWERED. A rotation whose response is lost
 * (a train going into a tunnel) leaves the client holding the spent token
 * while the server holds a successor nobody received. Its retry used to get
 * the race answer for 30 s and then a 401 that cleared the cookie: the user
 * was signed out by the network. A presented rotated token is now judged on
 * what happened to its successor:
 *
 *  - successor issued under 30 s ago (REFRESH_RACE_MS): a concurrent refresh
 *    of the same client. Race answer, as before.
 *  - successor never used (no request authenticated with its access token,
 *    session-use.ts, and never refreshed itself), the rotation under
 *    LOST_RESPONSE_WINDOW_MS old, and the same User-Agent that rotated it:
 *    the response was lost. The unused successor is replaced by a new one in
 *    the same family and that pair is answered. There is still exactly one
 *    live session; the window counts from the first rotation and never
 *    restarts, and the reissue restarts the 30 s race answer, so concurrent
 *    replays get one winner and the others the race answer.
 *  - anything else (successor used, another client, past the window but the
 *    row still kept): the token was reused by someone who should not have
 *    it. The whole family is revoked and the caller gets a 401 (theft).
 *
 * ATOMICITY. The decision is taken under a row lock on the presented session
 * (and on its successor), and it writes a stamp (successor_issued_at). The
 * issue (createSession) runs in a second transaction that re-checks the
 * replaced successor is still unused, inserts the new one, and links it only
 * if the stamp is unchanged; otherwise it rolls back as a race. No path
 * leaves two live successors or a second family.
 */
export async function refreshSession(
  refreshToken: string,
  client: {
    userAgent?: string | null
    /** Host binding: the org this host serves; a session of any other org is refused untouched. */
    expectedOrgId?: string | null
  } = {},
): Promise<TokenPair> {
  // The rotation writes the session rows of an org found by the token: counted
  // from the lookup, refused while the org is frozen or moved.
  const ends: Array<() => void> = []
  try {
    return await refreshSessionUnder(refreshToken, client, async (orgId) => {
      ends.push(beginOrgActivity(orgId, "writes"))
      await assertOrgAcceptsWrites(orgId)
    })
  } finally {
    for (const end of ends) end()
  }
}

async function refreshSessionUnder(
  refreshToken: string,
  client: {
    userAgent?: string | null
    expectedOrgId?: string | null
  },
  gate: (orgId: string) => Promise<void>,
): Promise<TokenPair> {
  const tokenHash = hashToken(refreshToken)
  const uaHash = hashToken(client.userAgent ?? "")
  const K = sql.raw(schemaRef("kernel"))
  // Sessions this decision ends (a revoked family, an inactive user's row).
  const endedIds: string[] = []

  // The gate reads the org's transfer state on privileged connections of its
  // own, so it runs before the rotation's transaction, on the token's org (a
  // session never changes org), never under it.
  const [gated] = await withSystemDb("refresh-session-org", (tx) =>
    tx
      .select({ orgId: sessions.orgId })
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, tokenHash))
      .limit(1),
  )
  if (gated) await gate(gated.orgId)

  const decision = await withSystemDb("refresh-session", async (tx): Promise<RefreshDecision> => {
    const now = new Date()
    const [session] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, tokenHash))
      .for("update")
    // Not there, or not the row the gate was asked about: never rotated ungated.
    if (!session || session.orgId !== gated?.orgId) {
      return { kind: "invalid", reason: "unknown token" }
    }
    // Presented on another org's host: refused, and nothing about the session
    // changes (its own host may still rotate it).
    if (client.expectedOrgId !== undefined && session.orgId !== client.expectedOrgId) {
      return { kind: "invalid", reason: "another org's host" }
    }
    if (session.expiresAt.getTime() <= now.getTime()) {
      await tx.delete(sessions).where(eq(sessions.id, session.id))
      return { kind: "invalid", reason: "expired" }
    }
    const familyId = session.familyId ?? session.id

    const userIsActive = async () => {
      // Lock the user row so a concurrent deactivateUser cannot slip between
      // this check and the issue.
      const [user] = await tx.execute(
        sql`SELECT id, status FROM ${K}.users WHERE id = ${session.userId} FOR UPDATE`,
      )
      return !!user && (user as { status?: string }).status === "active"
    }
    // THE SCOPE IS THE FAMILY, NEVER THE USER. A spent token comes back far
    // more often from the user's own device (an app relaunched with a stale
    // store, a restored backup) than from a thief, so ending it may sign out
    // only the sign-in that token belongs to. The user's other sign-ins (a
    // browser, a phone, another computer) are families of their own and keep
    // their sessions (refresh-lost-response-routes.test.ts pins it).
    const revokeFamily = async (reason: string): Promise<RefreshDecision> => {
      const revoked = await tx
        .delete(sessions)
        .where(sql`${sessions.familyId} = ${familyId} OR ${sessions.id} = ${session.id}`)
        .returning({ id: sessions.id })
      for (const r of revoked) endedIds.push(r.id)
      log.warn(
        {
          event: "refresh_token_reuse",
          reason,
          sessionId: session.id,
          familyId,
          userId: session.userId,
          orgId: session.orgId,
          rotatedAt: session.rotatedAt,
          revokedSessions: revoked.length,
        },
        `refresh token reuse detected (${reason}): session family revoked`,
      )
      return { kind: "reuse", reason }
    }

    if (!session.isGrace) {
      if (!(await userIsActive())) {
        await tx.delete(sessions).where(eq(sessions.id, session.id))
        endedIds.push(session.id)
        return { kind: "invalid", reason: "user not active" }
      }
      await tx
        .update(sessions)
        .set({
          isGrace: true,
          rotatedAt: now,
          successorIssuedAt: now,
          successorId: null,
          rotatedUaHash: uaHash,
          familyId,
          expiresAt: new Date(now.getTime() + ROTATED_ROW_RETENTION_MS),
        })
        .where(eq(sessions.id, session.id))
      return {
        kind: "issue",
        grace: false,
        userId: session.userId,
        orgId: session.orgId,
        scopeCeiling: session.scopeCeiling,
        rotation: { predecessorId: session.id, familyId, stamp: now, replaceSuccessorId: null },
      }
    }

    // A grace row from before migration 0224 carries no lineage: it keeps the
    // 30 s race answer it was created with (its expiry is that 30 s).
    if (!session.rotatedAt || !session.successorIssuedAt) return { kind: "race" }

    if (now.getTime() - session.successorIssuedAt.getTime() < REFRESH_RACE_MS) {
      return { kind: "race" }
    }
    if (now.getTime() - session.rotatedAt.getTime() > LOST_RESPONSE_WINDOW_MS) {
      return revokeFamily("presented after the lost-response window")
    }
    // No successor was ever linked (its issue failed), or it is gone (signed
    // out, evicted, revoked): nothing to hand back, and nothing to revoke.
    if (!session.successorId) return { kind: "invalid", reason: "rotation never completed" }
    const [successor] = await tx
      .select({ id: sessions.id, isGrace: sessions.isGrace, usedAt: sessions.usedAt })
      .from(sessions)
      .where(eq(sessions.id, session.successorId))
      .for("update")
    if (!successor) return { kind: "invalid", reason: "successor ended" }
    if (successor.isGrace || successor.usedAt) {
      // The case a client that failed to persist its rotated token would hit:
      // its successor was used (by a request or a refresh of its own) and the
      // spent token came back afterwards. The rule is unchanged (the family is
      // revoked as a theft); this line only says it was this case, with the
      // timings a triage needs to tell a client bug from a stolen token.
      log.warn(
        {
          event: "refresh_family_revoked_successor_used",
          successorUse: successor.isGrace ? "refresh" : "request",
          sessionId: session.id,
          successorId: successor.id,
          familyId,
          userId: session.userId,
          orgId: session.orgId,
          sinceRotationMs: now.getTime() - session.rotatedAt.getTime(),
          successorUsedAt: successor.usedAt,
          sameClient: session.rotatedUaHash === uaHash,
        },
        "refresh: spent token presented after its successor was used; revoking the family",
      )
      return revokeFamily(
        successor.isGrace ? "successor already refreshed" : "successor already used",
      )
    }
    if (session.rotatedUaHash !== uaHash) return revokeFamily("different client")
    if (!(await userIsActive())) return { kind: "invalid", reason: "user not active" }

    await tx.update(sessions).set({ successorIssuedAt: now }).where(eq(sessions.id, session.id))
    log.info(
      {
        event: "refresh_lost_response_grace",
        sessionId: session.id,
        replacedSuccessorId: successor.id,
        familyId,
        userId: session.userId,
        orgId: session.orgId,
        sinceRotationMs: now.getTime() - session.rotatedAt.getTime(),
      },
      "refresh: spent token replayed with its successor unused; reissuing the successor (lost response)",
    )
    return {
      kind: "issue",
      grace: true,
      userId: session.userId,
      orgId: session.orgId,
      scopeCeiling: session.scopeCeiling,
      rotation: {
        predecessorId: session.id,
        familyId,
        stamp: now,
        replaceSuccessorId: successor.id,
      },
    }
  })

  revokeSessions(endedIds, "refresh-refused")
  if (decision.kind === "race") throw new RefreshRaceError()
  if (decision.kind === "reuse") throw new RefreshReuseError(decision.reason)
  if (decision.kind === "invalid") {
    log.debug({ reason: decision.reason }, "refresh refused")
    throw new InvalidSessionError()
  }

  // The rotated session inherits the ceiling. Reloading the user's effective
  // permissions here is right (a revoked role must shrink the token), but they
  // are intersected with the ceiling again: before migration 0114 this line
  // re-minted a device-flow token with the user's FULL rights.
  return createSession(
    decision.userId,
    decision.orgId,
    decision.scopeCeiling ?? undefined,
    decision.rotation,
  )
}

/** Ends one session; answers whose it was (null for an unknown token). */
export async function logout(
  refreshToken: string,
): Promise<{ userId: string; orgId: string } | null> {
  const ends: Array<() => void> = []
  try {
    return await logoutUnder(refreshToken, async (orgId) => {
      ends.push(beginOrgActivity(orgId, "writes"))
      await assertOrgAcceptsWrites(orgId)
    })
  } finally {
    for (const end of ends) end()
  }
}

async function logoutUnder(
  refreshToken: string,
  gate: (orgId: string) => Promise<void>,
): Promise<{ userId: string; orgId: string } | null> {
  const tokenHash = hashToken(refreshToken)

  const [ended] = await withSystemDb("logout-session-read", (db) =>
    db
      .select({ id: sessions.id, userId: sessions.userId, orgId: sessions.orgId })
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, tokenHash))
      .limit(1),
  )
  if (!ended) return null
  // The gate reads the org's transfer state on privileged connections of its
  // own, so it runs between the two transactions, never under one. The org's
  // activity it counts (logout) spans both.
  await gate(ended.orgId)

  // Delete only this session. Grace-period sessions (from consumed refresh tokens)
  // expire naturally in 30 seconds — no need to sweep them here.
  await withSystemDb("logout", (db) => db.delete(sessions).where(eq(sessions.id, ended.id)))
  // Its access tokens stop authenticating now, not when they expire.
  revokeSessions([ended.id], "logout")
  return { userId: ended.userId, orgId: ended.orgId }
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<TokenPair> {
  const [user] = await withSystemDb("change-password-lookup", (db) =>
    db
      .select({ orgId: users.orgId, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )
  if (!user) throw new AuthServiceError("User not found", 404)
  if (!user.passwordHash) throw new AuthServiceError("Account uses OAuth login only", 400)

  const valid = await verifyPassword(currentPassword, user.passwordHash)
  if (!valid) throw new AuthServiceError("Current password is incorrect", 401)

  const newHash = await hashPassword(newPassword)
  const newRefreshToken = generateToken()
  const newRefreshTokenHash = hashToken(newRefreshToken)
  const newSessionId = crypto.randomUUID()

  // Insert new session inside the transaction to prevent lockout if post-tx
  // session creation were to fail (user would have no active sessions)
  let endedIds: string[] = []
  const { updatedUser, permissions, secondFactorPending } = await withPrivilegedDb(
    user.orgId,
    "change-password",
    async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash: newHash, authVersion: sql`auth_version + 1` })
        .where(eq(users.id, userId))
      const ended = await tx
        .delete(sessions)
        .where(eq(sessions.userId, userId))
        .returning({ id: sessions.id })
      endedIds = ended.map((r) => r.id)
      // The person's MCP connections end with their sessions: a standing
      // credential consented by whoever else had the account must not survive.
      await revokeAllMcpConnectionsForUser(tx, userId)
      // And their push delivery: a device registered by someone else must not
      // keep receiving message previews (push/end-user-push.ts).
      await removeAllPushDeliveryForUser(tx, userId)
      await tx.insert(sessions).values({
        id: newSessionId,
        orgId: user.orgId,
        userId,
        refreshTokenHash: newRefreshTokenHash,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        familyId: newSessionId,
      })

      const [u] = await tx
        .select({
          name: users.name,
          authVersion: users.authVersion,
          permissionVersion: users.permissionVersion,
          userType: users.userType,
        })
        .from(users)
        .where(eq(users.id, userId))
      const perms = await loadEffectivePermissions(tx, userId, user.orgId)
      const pending = await adminSecondFactorPending(tx, userId, user.orgId, perms.scopes)
      return { updatedUser: u, permissions: perms, secondFactorPending: pending }
    },
  )

  // The auth_version bump invalidates every previously-issued access token for
  // this user; drop the cached auth state on all nodes so those tokens stop
  // authenticating immediately rather than after the per-process cache TTL.
  invalidateAuthCache(userId)
  revokeSessions(endedIds, "password-change")

  const accessToken = await signSessionToken(
    { userId, orgId: user.orgId, sid: newSessionId },
    updatedUser,
    // Same rule as createSession: an administrator still to enroll a second
    // factor gets a session that can only enroll.
    secondFactorPending
      ? {
          roles: [],
          scopes: [],
          dimensionGrants: {},
          restricted: true,
          secondFactorRequired: true,
        }
      : {
          roles: permissions.roles,
          scopes: permissions.scopes,
          dimensionGrants: permissions.dimensionGrants,
        },
  )

  return {
    accessToken,
    refreshToken: newRefreshToken,
    orgId: user.orgId,
    userId,
    admin: updatedUser?.userType !== "external" && holdsAdminScope(user.orgId, permissions.scopes),
  }
}

export async function countSessionsForUser(userId: string): Promise<number> {
  const [row] = await withSystemDb("count-sessions", (db) =>
    db.select({ n: count() }).from(sessions).where(eq(sessions.userId, userId)),
  )
  return row?.n ?? 0
}
