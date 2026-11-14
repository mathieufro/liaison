// SPDX-License-Identifier: FSL-1.1-ALv2
import type { MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import type Redis from "ioredis"
import type { AppEnv } from "~/app"
import { env } from "~/lib/env"
import { envFlag } from "~/lib/env-boolean"
import { rootLogger } from "~/lib/logger"
import { getClientIp } from "~/lib/request-context"
import { checkRateLimit } from "~/middleware/rate-limiter"

/**
 * Body cap and per-IP budget for the public routes that live OUTSIDE `/api`
 * and so miss the `/api/*` body limit and IP limiter: the MCP OAuth endpoints,
 * the MCP device grant, discovery documents and the MCP transport itself.
 *
 * Both run BEFORE the route parses anything, so an anonymous client cannot make
 * the process read a large body, validate it, or insert a row before it is
 * counted. A request over the cap is refused 413 from the declared length or
 * the streamed byte count, whichever comes first.
 */

/** OAuth, device-grant and discovery bodies are a handful of short fields. */
export const PUBLIC_OAUTH_BODY_MAX_BYTES = 64 * 1024
/** A JSON-RPC message can carry tool arguments, so the transport gets the webhook ceiling. */
export const MCP_TRANSPORT_BODY_MAX_BYTES = 10 * 1024 * 1024
/** GET /api/client-policy per address per minute; the shells read it once per connection. */
export const CLIENT_POLICY_RATE_LIMIT = 30

interface PublicBudget {
  name: string
  /** Matches the request, or null when the budget does not apply. */
  applies: (method: string, path: string) => boolean
  limit: number
  windowSeconds: number
}

const BUDGETS: PublicBudget[] = [
  {
    name: "mcp-dcr",
    applies: (m, p) => m === "POST" && p === "/mcp/oauth/register",
    limit: 10,
    windowSeconds: 60,
  },
  {
    name: "mcp-token",
    applies: (m, p) => m === "POST" && p === "/mcp/oauth/token",
    limit: 60,
    windowSeconds: 60,
  },
  {
    name: "mcp-device-initiate",
    applies: (m, p) => m === "POST" && p === "/mcp/device/initiate",
    limit: 20,
    windowSeconds: 60,
  },
  {
    // The login device flow's public initiate also inserts a row per call; the
    // generic /api/* per-IP ceiling is sized for page loads, not for this.
    name: "device-flow-initiate",
    applies: (m, p) => m === "POST" && p === "/api/auth/device-flow/initiate",
    limit: 20,
    windowSeconds: 60,
  },
  {
    // The per-code 1/s poll limit only bites for a known code; this bounds a
    // client guessing codes.
    name: "mcp-device-poll",
    applies: (_m, p) => p.startsWith("/mcp/device/") && p !== "/mcp/device/initiate",
    limit: 300,
    windowSeconds: 60,
  },
  {
    // The shells' version policy (modules/client-policy); the /api/* ceiling
    // is sized for page loads.
    name: "client-policy",
    applies: (m, p) => m === "GET" && p === "/api/client-policy",
    limit: CLIENT_POLICY_RATE_LIMIT,
    windowSeconds: 60,
  },
  {
    // A commercial mail's opt-out link (modules/mail/opt-out-routes.ts): a person
    // opens it once or twice, a mail scanner a few times.
    name: "opt-out",
    applies: (_m, p) => p.startsWith("/public/opt-out/"),
    limit: 30,
    windowSeconds: 60,
  },
  {
    name: "well-known",
    applies: (_m, p) => p.startsWith("/.well-known/"),
    limit: 120,
    windowSeconds: 60,
  },
]

export function isPublicOauthSurface(path: string): boolean {
  return (
    path.startsWith("/mcp/oauth/") ||
    path.startsWith("/mcp/device/") ||
    path.startsWith("/.well-known/")
  )
}

export function publicSurfaceBodyLimit(): MiddlewareHandler<AppEnv> {
  const small = bodyLimit({ maxSize: PUBLIC_OAUTH_BODY_MAX_BYTES })
  const transport = bodyLimit({ maxSize: MCP_TRANSPORT_BODY_MAX_BYTES })
  return async (c, next) => {
    const path = c.req.path
    if (isPublicOauthSurface(path) || path.startsWith("/public/opt-out/")) return small(c, next)
    if (path === "/mcp") return transport(c, next)
    return next()
  }
}

/**
 * The per-IP budgets. Disabled under NODE_ENV=test unless
 * RATE_LIMIT_FORCE_ENABLED, exactly like the `/api/*` IP limiter. Fails closed
 * (503) when Redis is unavailable, also like it.
 */
export function publicSurfaceRateLimit(redis: Redis): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (env.NODE_ENV === "test" && !envFlag("RATE_LIMIT_FORCE_ENABLED")) return next()
    const budget = BUDGETS.find((b) => b.applies(c.req.method, c.req.path))
    if (!budget) return next()
    const ip = getClientIp(c)
    try {
      const result = await checkRateLimit(redis, [
        {
          identifier: `public:${budget.name}:${ip}`,
          limit: budget.limit,
          windowSeconds: budget.windowSeconds,
        },
      ])
      if (!result.allowed) {
        rootLogger.warn({ ip, budget: budget.name }, "public route rate limit exceeded")
        c.header("Retry-After", String(result.failed.retryAfterSeconds))
        throw new HTTPException(429, { message: "Too many requests" })
      }
    } catch (err) {
      if (err instanceof HTTPException) throw err
      rootLogger.error({ err }, "public-surface limiter failed — blocking request (fail-closed)")
      throw new HTTPException(503, { message: "Service temporarily unavailable" })
    }
    return next()
  }
}
