// SPDX-License-Identifier: FSL-1.1-ALv2
import * as jose from "jose"
import { z } from "zod"

// HS256 is sufficient for single-server Phase 1-3. Migrate to RS256 in Phase 5+.
interface AccessTokenPayload {
  userId: string
  orgId: string
  name: string
  authVersion: number
  permissionVersion: number
  roles?: string[]
  scopes?: string[]
  dimensionGrants?: Record<string, string[]>
  // Phase 12: present only on MCP connection tokens. signAccessToken builds
  // from a fixed allowlist, so this must be added explicitly here and in the
  // builder + verify return below or it is silently dropped.
  mcpConnectionId?: string
  // Present only on AGENT-SCOPED MCP connection tokens (P3): the bound agent
  // and the human whose live grants the token's scopes were intersected with.
  // Same fixed-allowlist caveat as mcpConnectionId above: a claim that is not
  // named here, in the schema and in the builder spread is silently dropped.
  // Identity only. These claims carry no key material and never will: the
  // token is a bearer credential handed to an external runtime.
  agentId?: string
  grantorUserId?: string
  // Present (true) only on tokens of a RESTRICTED session: a device-flow login
  // whose scopes are capped by a stored ceiling. Such a token mints no further
  // credential (modules/auth/session-ceiling.ts). Same allowlist caveat.
  restricted?: boolean
  // Present (true) only on a session of an administrator whose org requires a
  // second factor they have not set up: no scopes, restricted, and allowed to
  // enroll only (admin-second-factor.ts). Same allowlist caveat.
  secondFactorRequired?: boolean
  // The refresh session (kernel.sessions.id) that minted this token. The auth
  // middleware stamps the session's first use from it (session-use.ts), which
  // is how a refresh tells a lost response from a replayed token. Identity
  // only; it grants nothing. Same allowlist caveat.
  sid?: string
  // The row's `user_type`, read from the database by the mint site. Never a
  // claim: signAccessToken refuses an external user, whose only token is a
  // portal token (signPortalToken).
  userType?: string
}

/** Who a portal token is for, and nothing about what they may do. */
export interface PortalTokenPayload {
  userId: string
  orgId: string
  name: string
  authVersion: number
  permissionVersion: number
  sid?: string
}

const ACCESS_TOKEN_EXPIRY = "15m"

// Defense-in-depth: we sign these tokens ourselves with a pinned HS256 alg, so a
// verified payload is authentic. This schema does NOT guard against forgery — it
// guards against a malformed/missing claim (a non-array `scopes`, a string where
// an object is expected, an absent `userId`) silently coercing through the blind
// casts below and propagating untyped into RLS `SET LOCAL` / downstream calls. A
// wrong-typed claim is rejected as a verification failure; legitimately optional
// claims keep their previous default fallbacks (`.default(...)`).
const accessTokenPayloadSchema = z.object({
  userId: z.string(),
  orgId: z.string(),
  name: z.string().default("Unknown"),
  authVersion: z.number().default(1),
  permissionVersion: z.number().default(1),
  roles: z.array(z.string()).default([]),
  scopes: z.array(z.string()).default([]),
  dimensionGrants: z.record(z.string(), z.array(z.string())).default({}),
  mcpConnectionId: z.string().optional(),
  agentId: z.string().optional(),
  grantorUserId: z.string().optional(),
  restricted: z.boolean().optional(),
  secondFactorRequired: z.boolean().optional(),
  sid: z.string().uuid().optional(),
})

export async function signAccessToken(
  payload: AccessTokenPayload,
  secret: string,
  expiresInSeconds?: number,
): Promise<string> {
  if (payload.userType === "external") {
    throw new Error("an external user gets a portal token, never an access token")
  }
  const key = new TextEncoder().encode(secret)
  const builder = new jose.SignJWT({
    userId: payload.userId,
    orgId: payload.orgId,
    name: payload.name,
    authVersion: payload.authVersion,
    permissionVersion: payload.permissionVersion,
    ...(payload.roles && { roles: payload.roles }),
    ...(payload.scopes && { scopes: payload.scopes }),
    ...(payload.dimensionGrants && { dimensionGrants: payload.dimensionGrants }),
    ...(payload.mcpConnectionId && { mcpConnectionId: payload.mcpConnectionId }),
    ...(payload.agentId && { agentId: payload.agentId }),
    ...(payload.grantorUserId && { grantorUserId: payload.grantorUserId }),
    ...(payload.restricted === true && { restricted: true }),
    ...(payload.secondFactorRequired === true && { secondFactorRequired: true }),
    ...(payload.sid && { sid: payload.sid }),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience("access")

  if (expiresInSeconds !== undefined) {
    builder.setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
  } else {
    builder.setExpirationTime(ACCESS_TOKEN_EXPIRY)
  }

  return builder.sign(key)
}

/**
 * The token of an external user. Its audience is `portal`, so verifyAccessToken
 * refuses it and no route behind the session middleware ever opens to it. It
 * carries no roles, scopes or grants: the portal's reads are decided by the
 * liaison_portal role and the views of schema `portal`.
 */
export async function signPortalToken(
  payload: PortalTokenPayload,
  secret: string,
): Promise<string> {
  return new jose.SignJWT({
    userId: payload.userId,
    orgId: payload.orgId,
    name: payload.name,
    authVersion: payload.authVersion,
    permissionVersion: payload.permissionVersion,
    ...(payload.sid && { sid: payload.sid }),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience("portal")
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .sign(new TextEncoder().encode(secret))
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenPayload> {
  const key = new TextEncoder().encode(secret)
  // Pin the accepted algorithm — without `algorithms`, jose accepts any HMAC
  // family alg the token header asserts (algorithm-flexibility). HS256 is the
  // only algorithm we ever sign with (see signAccessToken).
  const { payload } = await jose.jwtVerify(token, key, {
    audience: "access",
    algorithms: ["HS256"],
  })
  // Validate the verified claims instead of blind-casting. safeParse → throw a
  // clear auth error so callers (auth middleware) treat a malformed payload the
  // same as any other verification failure (→ 401), never coercing a bad claim
  // through untyped.
  const parsed = accessTokenPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`Invalid access token payload: ${parsed.error.message}`)
  }
  return parsed.data
}
