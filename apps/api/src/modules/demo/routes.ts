// SPDX-License-Identifier: FSL-1.1-ALv2
//
// POST /api/demo/orgs -- the public self-serve demo signup.
//
// MOUNTED ONLY UNDER THE GATE. When LIAISON_DEMO_MODE is off, app.ts never
// calls `mountDemoRoutes`, so this file is not even imported and the path 404s
// like any other unknown route. The `isDemoModeEnabled()` check inside the
// handler is belt-and-braces for a process that flips the flag at run time; it
// is not the gate.
//
// THIS IS NOT THE QA SEED HARNESS. `/api/_test/*` can set any user's scopes,
// install an arbitrary tarball and create tenants, and is fatal in production
// for exactly that reason. Nothing here bypasses RLS, nothing here takes a
// scope, a role, an app or an org id from the caller, and the only thing the
// caller controls is their own name and email address. The two mechanisms
// share no code.
//
// WHY THE ROUTE DOES NOT WAIT FOR THE SEED. Populating a workspace takes up to
// two minutes; the global `/api/*` request timeout is thirty seconds and does
// not cancel the handler it times out. So the route used to hand the visitor a
// 504 while the seed ran to completion behind it, marking an org and minting a
// session nobody received, and each retry spent one of three hourly attempts
// until the third was a lockout over three seeded orphans.
//
// Now the request does only the part a visitor cannot use the product without:
// an org, an admin user, the agent surface and a session. That is seconds, well
// inside the timeout, and it is measured by a test that installs a seeder which
// never returns. The seed itself runs behind the response, and the workspace
// fills in while the visitor watches it. Three properties make that safe:
//
//   NEW ORG    every "Start the demo" creates a new workspace. An address never
//              resumes one: the address is unverified, so resuming by it handed
//              whoever typed a visitor's address that visitor's workspace. Only
//              the start's own random signup key does (SIGNUP_KEY).
//   DEGRADE    a seed that fails leaves a usable, emptier org, because the org
//              was already complete before the seed started. There is no state
//              in which the visitor is holding a wedged workspace.
//   OBSERVE    GET /api/demo/orgs/:orgId/status says how far it has got, so the
//              UI polls instead of guessing.
//
// THE EMAIL ROUND TRIP COMES AFTER THE DOOR, NOT BEFORE IT. Start creates the
// workspace at once and mails the visitor a code in the same request, so the
// code is waiting in their inbox before they first ask an agent anything. The
// workspace is browsable unverified: it is brand new, holds only fixture data,
// is marked `variant: "visitor"` with an expiry, cannot send mail off the box
// and cannot store a real connector credential. What waits on the code is
// SPEND: agents run on this box's key only for a confirmed address, within a
// budget keyed on that mailbox and on the client network recorded here
// (demo-verification.ts, demo-spend.ts). A visitor's own key needs no code.
//
// TURNSTILE FIRST. Every public POST here carries a fresh invisible Turnstile
// token and checks it before anything else (demo-turnstile.ts): a bot spends
// none of the budgets behind it, and a failed challenge, a disposable address
// or a full domain cap never records a failed attempt on the brute-force
// counters login shares with this route.
//
// THE CLIENT IS NOT ALWAYS THE SOCKET PEER. Behind an edge that overwrites
// X-Forwarded-For and proxies over loopback, every visitor shares the peer, so
// the per-IP limits read the client through demo-peer.ts `demoClientIp`.
//
// WHICH IS WHY THE ADDRESS IS NOT THE LOGIN. An unverified address must not be
// an identity: not a key to resume a workspace by (anybody can type anybody's
// address), and not a `kernel.users.email` either, where it would sit beside a
// real account holding the same address on this instance and turn that
// person's email-only sign-in ambiguous (the login and sign-in-code lookups
// refuse an address held in two orgs). The visitor's account gets a generated
// internal address on a reserved, undeliverable domain (`demoInternalLogin`);
// the address they typed is stored only as their lead (demo-leads.ts), under
// the notice the form shows.
import crypto from "node:crypto"
import {
  DEMO_DEFAULT_WORLD,
  DEMO_WORLD_NEEDS,
  type DemoEntry,
  type DemoNeed,
  type DemoWorldId,
  demoEntrySchema,
  demoNeedsSchema,
  demoWorldOfEntry,
  orgKernelSettingsSchema,
  resolveLocale,
  type ShippedLocale,
} from "@liaison/shared"
import type { Context } from "hono"
import { Hono } from "hono"
import { every } from "hono/combine"
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import type Redis from "ioredis"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { sinkEntriesForOrg } from "~/lib/effect-sink"
import { env } from "~/lib/env"
import { isLoadHarnessAddress, isLoadOrg, verifyHarnessContext } from "~/lib/load-harness"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"

import { requestRefreshTokenDelivery, setRefreshTokenCookie, success } from "~/lib/response"
import { getOrgKernelSettings } from "~/lib/settings"
import { UUID_RE } from "~/lib/uuid"
import { zValidator } from "~/lib/validate"
import { authMiddleware } from "~/middleware/auth"
import { checkBruteForce, recordFailedAttempt } from "~/middleware/brute-force"
import { checkRateLimit } from "~/middleware/rate-limiter"
import { requireScope } from "~/middleware/require-scope"
import { isInstanceOperatorOrg } from "~/modules/apps/operator-org"
import { createSession } from "~/modules/auth/auth"
import { demoBudgetCaps, demoBudgetSnapshotForOrg } from "~/modules/demo/demo-budget"
import {
  demoDomainCapKey,
  emailDomain,
  isDisposableDomain,
  maskDemoEmail,
  normalizeDemoEmail,
} from "~/modules/demo/demo-email"
import {
  assertDemoOrgActive,
  countVisitorOrgs,
  demoExpiryMiddleware,
} from "~/modules/demo/demo-expiry"
import {
  countDemoVerifiedSince,
  DEMO_LEAD_NOTICE_VERSION,
  demoLeadsCsv,
  leadForDemoOrg,
  listDemoLeads,
  moveDemoLead,
  optOutDemoLead,
  recordDemoLead,
  setDemoLeadNotifyManaged,
} from "~/modules/demo/demo-leads"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import {
  demoEntryOf,
  demoNextStepsShownOf,
  demoWorldOf,
  endVisitorOrg,
  loadDemoMarker,
  loadDemoOrg,
  recordDemoEntry,
  recordDemoNextStepsShown,
  visitorMarker,
} from "~/modules/demo/demo-org"
import { demoClientIp, demoNetworkKey, demoPeerBucket } from "~/modules/demo/demo-peer"
import {
  claimPooledOrg,
  createVisitorOrgShell,
  DEMO_INTERNAL_LOGIN_DOMAIN,
  demoInternalLogin,
  demoOrgSlug,
  demoWorldMonth,
  kickDemoPoolRefill,
  recordDemoPoolMiss,
} from "~/modules/demo/demo-pool"
import {
  type DemoProvisioningState,
  pollUntil,
  readProvisioning,
  writeProvisioning,
} from "~/modules/demo/demo-provisioning"
import { demoRecapForOrg } from "~/modules/demo/demo-recap"
import { withVisitorSeedSlot } from "~/modules/demo/demo-seed-gate"
import { fitPooledDemoWorld, seedDemoOrgData } from "~/modules/demo/demo-seeder"
import { zeroDemoOrgCredits } from "~/modules/demo/demo-spend"
import { type DemoTurnstileAction, verifyTurnstile } from "~/modules/demo/demo-turnstile"
import {
  DemoVerifyError,
  demoCodeOnRecord,
  sendDemoCode,
  sunkDemoCode,
  verifyDemoCode,
  verifyDemoLink,
} from "~/modules/demo/demo-verification"
import { demoWorldOrgName, enabledDemoWorlds } from "~/modules/demo/demo-worlds"
import { harnessRoutes } from "~/modules/demo/harness-routes"
import { demoScenariosRoutes } from "~/modules/demo/scenarios-routes"
import { serverT } from "~/modules/i18n/server-i18n"
import { forwardPlayedScenarios } from "~/modules/liaison-team/lead-forwarding"

const log = rootLogger.child({ module: "demo-signup" })

const SIGNUP_WINDOW_SECONDS = 60 * 60

/**
 * Readiness polls allowed per peer per hour. Generous on purpose: this budget
 * exists so a broken client cannot hammer the box, not to ration the visitor,
 * and a visitor polling their own workspace must never spend the signup budget
 * and lock themselves out of the thing they are waiting for.
 */
const DEMO_POLLS_PER_PEER_PER_HOUR = 600

const createDemoOrgSchema = z.object({
  /**
   * THE CALLER'S OWN NAME, not a name for the workspace. There is nothing for
   * them to name: the workspace IS the fictional company (its world's pack)
   * and they are being made its CEO, so this is what their account is called
   * and what the org's slug is derived from.
   */
  name: z.string().trim().min(1).max(80),
  /**
   * Where a follow-up would go: the lead, never the login. Never verified here;
   * see the header note.
   */
  email: z.string().trim().toLowerCase().email().max(254),
  /** What the visitor wants to see, one or more, in pick order. */
  needs: demoNeedsSchema,
  /** The unticked-by-default "send me news" checkbox. Absent means no. */
  newsOptIn: z.boolean().optional(),
  /**
   * The door's company question. Optional: the visitor can skip it. The answer
   * is what chooses the demo world, on the server (`visitorWorld`): the body
   * never names a world, and a `worldId` or `world` sent anyway is stripped by
   * this schema like any other unknown key.
   */
  entry: demoEntrySchema.optional(),
  /** A fresh invisible Turnstile token for `demo_start`. */
  turnstileToken: z.string().min(1).max(2048),
  /**
   * A random key the client makes once per "Start the demo" and resends on
   * every retry of that same start, each retry with a fresh Turnstile token.
   * It is how a caller whose response was lost gets back the workspace that
   * start made. Optional so an older client still works; see SIGNUP_KEY.
   */
  signupKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,128}$/)
    .optional(),
})

// The visitor account's generated login and the org slug are made in
// demo-pool.ts, which builds a pooled org exactly the way this route builds one.
export { DEMO_INTERNAL_LOGIN_DOMAIN, demoInternalLogin, demoOrgSlug }

/** The visitor's language, from Accept-Language. There is no account to read yet. */
function requestLocale(header: string | undefined): ShippedLocale {
  const first = header?.split(",")[0]?.trim()
  return resolveLocale(null, first ?? null)
}

/**
 * The tight per-peer limiter for the demo surface.
 *
 * Registered by `useDemoRateLimit` AHEAD of the global `/api/*` limiter, so a
 * signup flood is spent against the small budget first instead of eating the
 * deployment-wide one on its way to being refused. Pre-auth, and fail-closed
 * for the same reason as the global limiter: a Redis outage must not turn the
 * tightest limit on the box into no limit at all.
 *
 * KEYED ON THE SOCKET PEER, not on `getClientIp`. See demo-peer.ts: one
 * client-supplied `X-Forwarded-For` was enough to give an attacker a fresh
 * bucket per request, and therefore unbounded org creation, each one a full
 * seed. The peer address comes from the transport and is the same value
 * whatever TRUSTED_PROXY_HOPS claims about the proxy chain.
 *
 * Two budgets, because the surface has two kinds of request. Creating a
 * workspace is expensive and rare. Polling the one you were just given, or
 * opting a lead out, is cheap and frequent, and must not be able to lock its
 * own owner out of the workspace it is reporting on.
 *
 * So EVERY request here, the signup POST included, spends the cheap budget,
 * and a signup spends the signup budget too (`spendSignupBudget`, in the route).
 */
export function demoSignupRateLimiter(redisClient: Redis) {
  return createMiddleware<AppEnv>(async (c, next) => {
    // A request signed with the box's harness key (a synthetic visitor of a
    // load run, lib/load-harness.ts) is not a peer to throttle: a load
    // generator is one peer for a thousand visitors. The box-wide caps of the
    // load lane still apply on the routes. A refused signature is answered by
    // the route itself (404 or 403).
    if ((await verifyHarnessContext(c)).kind === "valid") return next()
    const peer = demoPeerBucket(c)
    await spendDemoBudget(c, redisClient, {
      identifier: `demo-poll:${peer}`,
      limit: DEMO_POLLS_PER_PEER_PER_HOUR,
      windowSeconds: SIGNUP_WINDOW_SECONDS,
    })
    await next()
  })
}

/**
 * Spend one request of a per-peer budget, or refuse with 429 and the
 * Retry-After. Fail-closed: a Redis outage must not turn the tightest limit on
 * the box into no limit at all.
 */
async function spendDemoBudget(
  c: Context,
  redisClient: Redis,
  bucket: { identifier: string; limit: number; windowSeconds: number },
): Promise<void> {
  try {
    const result = await checkRateLimit(redisClient, [bucket])
    if (!result.allowed) {
      log.warn({ bucket: bucket.identifier }, "demo rate limit exceeded")
      c.header("Retry-After", String(result.failed.retryAfterSeconds))
      throw new HTTPException(429, {
        message: serverT(
          requestLocale(c.req.header("accept-language")),
          "kernel.demo.signupRateLimited",
        ),
      })
    }
  } catch (err) {
    if (err instanceof HTTPException) throw err
    log.error({ err }, "demo signup rate limiter failed, blocking request (fail-closed)")
    throw new HTTPException(503, { message: "Service temporarily unavailable" })
  }
}

/**
 * The signup budget: spent only by a request that is about to create an org.
 *
 * A signed load-harness start (`synthetic`) spends the load lane's own
 * box-wide budget and workspace cap (LIAISON_DEMO_SYNTHETIC_*), never the
 * visitors': a load run, however large, cannot lock real visitors out. An
 * unsigned start spends the visitor budgets, which no signed start touches.
 */
async function spendSignupBudget(
  c: Context,
  peer: string,
  opts: { synthetic: boolean } = { synthetic: false },
): Promise<void> {
  if (opts.synthetic) {
    await spendDemoBudget(c, redis, {
      identifier: "demo-signup-synthetic",
      limit: env.LIAISON_DEMO_SYNTHETIC_PER_HOUR,
      windowSeconds: SIGNUP_WINDOW_SECONDS,
    })
    const { synthetic } = await countVisitorOrgs()
    if (synthetic >= env.LIAISON_DEMO_SYNTHETIC_MAX_ORGS) {
      log.warn(
        { synthetic, cap: env.LIAISON_DEMO_SYNTHETIC_MAX_ORGS },
        "demo synthetic workspace cap reached, refusing a load-harness start",
      )
      c.header("Retry-After", "600")
      throw new HTTPException(503, { message: "Service temporarily unavailable" })
    }
    return
  }
  await spendDemoBudget(c, redis, {
    identifier: `demo-signup:${peer}`,
    limit: env.LIAISON_DEMO_SIGNUPS_PER_IP_PER_HOUR,
    windowSeconds: SIGNUP_WINDOW_SECONDS,
  })
  await spendBoxSignupBudget(c)
}

/**
 * The box-wide half of the signup budget: the hourly ceiling and the live
 * workspace cap. Spent by a signup and by a start-over alike, since both hand
 * a visitor a workspace.
 */
async function spendBoxSignupBudget(c: Context): Promise<void> {
  // Box-wide ceiling, independent of how many addresses the caller has.
  await spendDemoBudget(c, redis, {
    identifier: "demo-signup-global",
    limit: env.LIAISON_DEMO_SIGNUPS_PER_HOUR,
    windowSeconds: SIGNUP_WINDOW_SECONDS,
  })
  // Cap on live visitor workspaces: the database must not fill faster than the
  // reaper empties it.
  const { total } = await countVisitorOrgs()
  if (total >= env.LIAISON_DEMO_MAX_VISITOR_ORGS) {
    log.error(
      { total, cap: env.LIAISON_DEMO_MAX_VISITOR_ORGS, alert: "demo_visitor_org_cap" },
      "demo visitor workspace cap reached, refusing signup",
    )
    c.header("Retry-After", "600")
    throw new HTTPException(503, { message: "Service temporarily unavailable" })
  }
}

// ── Signup keys: a lost response is recoverable ─────────────────────────────
//
// SIGNUP_KEY. A signup can outlive the request that carried it: the global
// request timeout answers 504 without cancelling the handler, and a client
// gives up on its own clock. The org, the admin, the lead and the code are made
// regardless, and the session travels only in the response, so before this
// nobody could ever enter that org (verifying its address by link confirms the
// lead, it signs nobody in).
//
// So the client sends a random key with the start and resends it on every
// retry. The first request claims the key, and records which workspace it
// made once that workspace is complete; a retry with the key gets a fresh
// session into THAT workspace instead of a second one, 202 while the first is
// still running, and 409 once the workspace is no longer a live demo org.
//
// This is not the old adopt-by-address step: the key is a secret the caller
// generated and only the caller holds, at least 32 url-safe characters, and it
// is stored only as a SHA-256 under a TTL. It is also BOUND TO THE START'S
// NETWORK (demoNetworkKey, the /24 or /48 the per-network caps use): the hash
// covers the network and the key, so a key replayed from elsewhere names no
// record at all and is simply a new start under every limit. Typing someone's
// address reaches nothing.
//
// ORDER. Turnstile is checked first on every request, retries included. The
// key is consulted next, before the address rules, the signup budget and the
// brute-force counters: a resume creates nothing, so it spends no signup and
// records no failure, and a duplicate that loses the claim is told to wait
// before it can spend anything either. The needs and the name of a retry are
// ignored; the response carries what the first request picked.

/** How long a finished key resumes its workspace. Matches the signup window. */
const SIGNUP_KEY_DONE_TTL_SECONDS = SIGNUP_WINDOW_SECONDS
/**
 * How long a key stays "being created". Longer than any synchronous half will
 * take, so a retry never starts a second org while the first is still running;
 * a handler that died mid-way frees its key when this lapses.
 */
const SIGNUP_KEY_PENDING_TTL_SECONDS = 10 * 60

interface SignupKeyDone {
  state: "done"
  orgId: string
  userId: string
  slug: string
  needs: DemoNeed[]
  verification: { sent: boolean; emailMasked: string }
}

type SignupKeyRecord = { state: "pending" } | SignupKeyDone

/** The Redis key for a signup key: SHA-256 over the start's network and the key. */
function signupKeyRedisKey(signupKey: string, network: string): string {
  const digest = crypto.createHash("sha256").update(`${network}\n${signupKey}`).digest("hex")
  return `demo:signup-key:${digest}`
}

function parseSignupKeyRecord(raw: string | null): SignupKeyRecord | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Omit<Partial<SignupKeyDone>, "state"> & { state?: unknown }
    if (parsed.state === "pending") return { state: "pending" }
    if (
      parsed.state === "done" &&
      typeof parsed.orgId === "string" &&
      typeof parsed.userId === "string" &&
      typeof parsed.slug === "string"
    ) {
      return parsed as SignupKeyDone
    }
  } catch {
    // Unreadable: treated as held, below, never as free.
  }
  return { state: "pending" }
}

/** "Still being created, ask again": what a duplicate of a running start gets. */
function signupStillCreating(c: Context, retryAfterSeconds = 2) {
  c.header("Retry-After", String(retryAfterSeconds))
  return success(c, { state: "creating", retryAfter: retryAfterSeconds }, undefined, 202)
}

/**
 * THE ANSWER BUDGET. A start that cannot make its workspace quickly (the warm
 * pool is empty and the box is busy making new ones) answers 202 "creating"
 * once this budget is spent, instead of holding the request until a proxy cuts
 * it with a 504. The work carries on behind the answer and records the
 * workspace under the caller's signup key, so the caller's retry with that key
 * (the browser retries a 202 on its own) is handed the workspace, never a
 * second one. Well under a reverse proxy's usual 30 s and the browser's own
 * 40 s attempt timeout. Only a start that carries a signup key can be answered
 * early; one without has nothing to come back with, so it is awaited.
 */
export const demoSignupAnswer = {
  budgetMs: 15_000,
  /** What the 202 tells the caller to wait before asking again. */
  retryAfterSeconds: 5,
}

/**
 * Claim `redisKey` for a new start, or answer from what it already holds: a
 * session into the workspace it made, 202 while that start is running, 409 once
 * the workspace is gone. Null means the claim is this request's: go on and
 * create. Fail-closed like the limiter: a Redis outage is a 503, never a
 * second org.
 */
async function claimOrResumeSignup(c: Context, redisKey: string) {
  let raw: string | null
  try {
    const claimed = await redis.set(
      redisKey,
      JSON.stringify({ state: "pending" } satisfies SignupKeyRecord),
      "EX",
      SIGNUP_KEY_PENDING_TTL_SECONDS,
      "NX",
    )
    if (claimed === "OK") return null
    raw = await redis.get(redisKey)
  } catch (err) {
    log.error({ err }, "demo signup key lookup failed, blocking request (fail-closed)")
    throw new HTTPException(503, { message: "Service temporarily unavailable" })
  }
  // Gone between the SET and the GET (its TTL lapsed, or the first request
  // failed and released it): still never two creates for one key in flight,
  // so ask the caller to come back rather than racing a fresh claim.
  const record = parseSignupKeyRecord(raw) ?? { state: "pending" }
  if (record.state === "pending") return signupStillCreating(c)
  return resumeSignup(c, record)
}

/** A fresh session into the workspace a signup key recorded, re-checked to be live. */
async function resumeSignup(c: Context, record: SignupKeyDone) {
  const marker = await loadDemoMarker(record.orgId)
  const expiresAt = marker?.expiresAt ? Date.parse(marker.expiresAt) : Number.NaN
  if (marker?.variant !== "visitor" || !(expiresAt > Date.now())) {
    throw new HTTPException(409, { message: "This demo workspace no longer exists" })
  }
  const { state } = await readProvisioning(record.orgId)
  log.info({ orgId: record.orgId }, "demo signup resumed by its signup key")
  return visitorSession(c, record, marker.expiresAt ?? visitorExpiry(), state, 201, {
    needs: record.needs,
    verification: record.verification,
  })
}

async function recordSignupKey(redisKey: string, record: SignupKeyDone): Promise<void> {
  await redis.set(redisKey, JSON.stringify(record), "EX", SIGNUP_KEY_DONE_TTL_SECONDS)
}

/**
 * Free a key this request claimed but did not finish, so a retry may start
 * over. Only while it is still pending: a key that already names a workspace
 * keeps naming it even if building the response then failed.
 */
async function releaseSignupKey(redisKey: string): Promise<void> {
  try {
    const record = parseSignupKeyRecord(await redis.get(redisKey))
    if (record?.state === "pending") await redis.del(redisKey)
  } catch (err) {
    log.warn({ err }, "demo signup key release failed")
  }
}

/**
 * THE WORLD. The demo world a start opens is derived here, on the server, from
 * the door's answer and the worlds this box runs (`enabledDemoWorlds`): an
 * answer whose world is off opens the default world. The picks are kept only
 * where the world shows them, in pick order; a start left with none (a stale
 * tab posting another world's need) is refused before anything is spent or
 * created.
 */
function visitorWorld(
  c: Context,
  entry: DemoEntry | undefined,
  needs: readonly DemoNeed[],
): { worldId: DemoWorldId; needs: DemoNeed[] } {
  const worldId = demoWorldOfEntry(entry?.id, enabledDemoWorlds())
  const shown = DEMO_WORLD_NEEDS[worldId]
  const kept = needs.filter((need) => shown.includes(need))
  if (kept.length === 0) {
    throw demoError(c, 422, "needs_not_in_world", "kernel.demo.needsNotInWorld")
  }
  return { worldId, needs: kept }
}

export const demoRoutes = new Hono<AppEnv>()

demoRoutes.post("/orgs", zValidator("json", createDemoOrgSchema), async (c) => {
  // Run-time restatement of the mount-time gate. A request can only get here
  // with demo mode on, so this is unreachable in practice and deliberately
  // indistinguishable from the not-mounted case for anyone probing.
  if (!isDemoModeEnabled()) throw new HTTPException(404, { message: "Not found" })

  const { name, email, needs, newsOptIn, entry, turnstileToken, signupKey } = c.req.valid("json")
  const clientIp = demoClientIp(c)
  const peer = demoPeerBucket(c)
  const signupNetwork = demoNetworkKey(clientIp)
  const locale = requestLocale(c.req.header("accept-language"))

  // THE LOAD HARNESS (lib/load-harness.ts). A start signed with the box's
  // LOAD_HARNESS_KEY is a synthetic visitor: it skips Turnstile and the
  // per-network limits, spends the load lane's own box-wide budget and
  // workspace cap (never the visitors'), and its workspace is a load org,
  // whose effects go to the sink, never out. It must use a `@load.invalid` address, and no unsigned
  // start may: the two can never be mixed. A bad, stale or replayed signature
  // is refused outright.
  const harness = await verifyHarnessContext(c)
  // On a box without the key the harness does not exist: 404, as for any
  // route that is not there. A refused signature (bad, stale, replayed, wrong key) answers like an
  // absent key: 404, so the status never tells a scanner the harness is on.
  if (harness.kind === "refused") {
    log.warn({ reason: harness.reason }, "demo start with a refused harness signature")
    throw new HTTPException(404, { message: "Not found" })
  }
  const synthetic = harness.kind === "valid"
  if (synthetic !== isLoadHarnessAddress(email)) {
    throw demoError(c, 422, "disposable_email", "kernel.demo.errDisposable")
  }

  // TURNSTILE FIRST, before any budget or counter is touched: a token that
  // does not pass spends neither the box-wide signup budget nor this IP's, and
  // records no failed attempt against the address it typed. A retry of a start
  // carries its own fresh token and is checked like any other request.
  if (!synthetic) await requireTurnstile(c, turnstileToken, "demo_start", clientIp)

  // The world and the picks it shows, before any key, budget or org (WORLD).
  const world = visitorWorld(c, entry, needs)

  // A retry of a start this caller already made: hand back that workspace, or
  // say it is still being made, before anything is spent. See SIGNUP_KEY.
  const signupRedisKey = signupKey ? signupKeyRedisKey(signupKey, signupNetwork) : null
  if (signupRedisKey) {
    const answered = await claimOrResumeSignup(c, signupRedisKey)
    if (answered) return answered
  }
  try {
    return await startVisitorSignup(c, {
      name,
      email,
      needs: world.needs,
      worldId: world.worldId,
      newsOptIn,
      entry,
      peer,
      signupNetwork,
      locale,
      signupRedisKey,
      synthetic,
    })
  } catch (err) {
    // Nothing usable was recorded under the key, so a retry may start over.
    if (signupRedisKey) await releaseSignupKey(signupRedisKey)
    throw err
  }
})

/** Everything after Turnstile and the signup key: the rules, the budgets, the org. */
async function startVisitorSignup(
  c: Context,
  input: {
    name: string
    email: string
    needs: DemoNeed[]
    worldId: DemoWorldId
    newsOptIn?: boolean
    entry?: DemoEntry
    peer: string
    signupNetwork: string
    locale: ShippedLocale
    signupRedisKey: string | null
    synthetic: boolean
  },
) {
  const { name, email, needs, worldId, newsOptIn, entry, peer, locale, synthetic } = input
  if (synthetic) {
    // A signed harness start: the address is the harness's own, so the address
    // rules and the per-network counters do not apply; the load lane's own
    // box-wide budget and workspace cap do (never the visitors').
    await spendSignupBudget(c, peer, { synthetic: true })
    return createVisitorOrg(c, {
      name,
      email,
      emailNormalized: normalizeDemoEmail(email),
      emailCapKey: null,
      needs,
      worldId,
      newsOptIn,
      entry,
      signupNetwork: input.signupNetwork,
      ipBucket: peer,
      locale,
      signupRedisKey: input.signupRedisKey,
      synthetic: true,
    })
  }

  // Address rules next, still before any counter: a disposable inbox or a
  // domain already at its daily verification cap is refused outright, and
  // neither is a "failed attempt" (those counters are shared with login).
  const emailNormalized = normalizeDemoEmail(email)
  if (isDisposableDomain(emailDomain(emailNormalized))) {
    throw demoError(c, 422, "disposable_email", "kernel.demo.errDisposable")
  }
  const emailCapKey = demoDomainCapKey(emailNormalized)
  if (emailCapKey) {
    const verifiedToday = await countDemoVerifiedSince(
      { kind: "domain", capKey: emailCapKey },
      new Date(Date.now() - 24 * 3_600_000),
    )
    if (verifiedToday >= env.LIAISON_DEMO_DOMAIN_VERIFIED_PER_DAY) {
      throw demoError(c, 422, "domain_cap", "kernel.demo.errDomainCap")
    }
  }

  // EVERY START IS A NEW ORG. There used to be an "adopt" step here that handed
  // a caller back the workspace an earlier signup had made with the same
  // address from the same socket peer. Behind a reverse proxy every visitor
  // shares one peer, so it reduced to "same address": anybody typing a
  // visitor's address from a fresh browser was signed straight into that
  // visitor's workspace, with no proof they own the mailbox. An address is
  // never a key to a workspace now; the only ways back into one are the session
  // the signup response carried and the caller's own signup key (SIGNUP_KEY).
  await spendSignupBudget(c, peer)

  // The same brute-force guard the login route uses, on the same counters: an
  // address or a peer already locked out for hammering login does not get to
  // walk around that by minting a fresh workspace instead. Keyed on the peer
  // for the same reason the limiter is.
  let bruteForce: { allowed: boolean; retryAfter?: number }
  try {
    bruteForce = await checkBruteForce(redis, email, peer)
  } catch (err) {
    log.error({ err }, "brute-force check failed, blocking request (fail-closed)")
    throw new HTTPException(503, { message: "Service temporarily unavailable" })
  }
  if (!bruteForce.allowed) {
    c.header("Retry-After", String(bruteForce.retryAfter))
    throw new HTTPException(429, { message: "Too many attempts" })
  }

  try {
    return await createVisitorOrg(c, {
      name,
      email,
      emailNormalized,
      emailCapKey,
      needs,
      worldId,
      newsOptIn,
      entry,
      signupNetwork: input.signupNetwork,
      ipBucket: peer,
      locale,
      signupRedisKey: input.signupRedisKey,
      synthetic: false,
    })
  } catch (err) {
    // A signup that could not be completed is a failed attempt on the same
    // counters login uses, so a peer hammering a path that keeps failing runs
    // into the shared lockout instead of an unbounded retry budget.
    try {
      await recordFailedAttempt(redis, email, peer)
    } catch (recordErr) {
      log.warn({ err: recordErr }, "brute-force record failed")
    }
    throw err
  }
}

/**
 * A refusal with a machine code next to the localized sentence. The error
 * handler renders `{error: {message, code, details}}` for any error carrying a
 * numeric `status` and a string `code`.
 */
export class DemoHttpError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 | 422 | 429 | 503,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "DemoHttpError"
  }
}

function demoError(
  c: Context,
  status: DemoHttpError["status"],
  code: string,
  messageKey: string,
  extra: Record<string, unknown> = {},
): DemoHttpError {
  const message = serverT(requestLocale(c.req.header("accept-language")), messageKey)
  return new DemoHttpError(message, status, code, Object.keys(extra).length ? extra : undefined)
}

/** Refuse unless `token` passes Turnstile for `action` (400 `turnstile_failed`). */
async function requireTurnstile(
  c: Context,
  token: string | undefined,
  action: DemoTurnstileAction,
  clientIp: string | null,
): Promise<void> {
  const result = await verifyTurnstile(token, { action, remoteIp: clientIp })
  if (result.ok) return
  if (result.reason === "not_configured") {
    log.error(
      { alert: "demo_turnstile_unconfigured" },
      "TURNSTILE_SECRET_KEY unset: demo forms refuse",
    )
    throw demoError(c, 503, "turnstile_unavailable", "kernel.demo.errUnavailable")
  }
  throw demoError(c, 400, "turnstile_failed", "kernel.demo.errTurnstile")
}

const VERIFY_ERROR_KEYS: Record<DemoVerifyError["code"], string> = {
  code_invalid: "kernel.demo.verifyCodeInvalid",
  code_expired: "kernel.demo.verifyCodeExpired",
  code_attempts_exhausted: "kernel.demo.verifyAttemptsExhausted",
  code_send_limited: "kernel.demo.verifySendLimited",
  verify_limited: "kernel.demo.verifyLimited",
  disposable_email: "kernel.demo.errDisposable",
  demo_mail_unavailable: "kernel.demo.verifyMailUnavailable",
  no_lead: "kernel.demo.verifyNoLead",
}

function verifyHttpError(c: Context, err: DemoVerifyError): DemoHttpError {
  if (err.extra.retryAfter) c.header("Retry-After", String(err.extra.retryAfter))
  return demoError(c, err.status, err.code, VERIFY_ERROR_KEYS[err.code], err.extra)
}

/**
 * How far the workspace has filled in. Unauthenticated, like the signup that
 * produced it, and it discloses nothing: an org id is a v4 uuid the caller was
 * just handed, a non-demo org is a 404 exactly as an unknown one is, and the
 * body is a state word and two timestamps.
 */
demoRoutes.get("/orgs/:orgId/status", async (c) => {
  if (!isDemoModeEnabled()) throw new HTTPException(404, { message: "Not found" })
  const orgId = c.req.param("orgId")
  if (!UUID_RE.test(orgId)) throw new HTTPException(404, { message: "Not found" })
  const marker = await loadDemoMarker(orgId)
  if (!marker) throw new HTTPException(404, { message: "Not found" })
  const record = await readProvisioning(orgId)
  return success(c, {
    orgId,
    state: record.state,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? null,
    expiresAt: marker.expiresAt,
    /**
     * When the client should stop asking, computed from the ONE seed deadline
     * (demo-provisioning.ts). The web used to carry its own ten minute ceiling
     * against a seeder allowed fifteen, so a slow but healthy seed was declared
     * failed by the browser and the visitor was never told it had finished.
     * Null once the state is terminal.
     */
    pollUntil: pollUntil(record),
  })
})

/**
 * Refuses every org but the instance operator's, the same gate that keeps app
 * installs away from visitor orgs (operator-org.ts). Unconditional here: these
 * routes exist only on a demo instance, which is multi-tenant by definition, and
 * a visitor org is never the operator whatever the configuration says short of
 * naming it.
 */
const requireOperatorOrg = createMiddleware<AppEnv>(async (c, next) => {
  if (!(await isInstanceOperatorOrg(c.get("orgId")))) {
    throw new HTTPException(403, {
      message:
        "The demo leads export is reserved to the instance operator's organization (LIAISON_OPERATOR_ORG_ID)",
    })
  }
  await next()
})

/**
 * The leads export: every demo signup, as JSON (default) or CSV (`?format=csv`).
 * Authenticated, `kernel:org:admin`, and the instance operator's org only. Each
 * row carries its opt-out token, which is what an unsubscribe link is built
 * from; nothing is sent from here.
 */
demoRoutes.get(
  "/leads",
  authMiddleware(env.JWT_SECRET),
  requireScope("kernel:org:admin"),
  requireOperatorOrg,
  async (c) => {
    if (!isDemoModeEnabled()) throw new HTTPException(404, { message: "Not found" })
    const rows = await listDemoLeads()
    if (c.req.query("format") === "csv") {
      c.header("Content-Type", "text/csv; charset=utf-8")
      c.header("Content-Disposition", 'attachment; filename="demo-leads.csv"')
      c.header("Cache-Control", "no-store")
      return c.body(demoLeadsCsv(rows))
    }
    c.header("Cache-Control", "no-store")
    return success(c, rows, { total: rows.length })
  },
)

const optOutSchema = z.object({ token: z.string().min(32).max(128) })

/**
 * Opt a lead out, by the unguessable per-lead token an unsubscribe link carries.
 * Unauthenticated by design (the person opting out has no account), and it
 * answers the same whether or not the token names a lead, so it is no oracle.
 * POST, also usable as a one-click List-Unsubscribe-Post target; the token may
 * come in the JSON body or the query string.
 */
demoRoutes.post("/leads/opt-out", async (c) => {
  if (!isDemoModeEnabled()) throw new HTTPException(404, { message: "Not found" })
  let token: unknown = c.req.query("token")
  if (token === undefined) {
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null
    token = body?.token
  }
  const parsed = optOutSchema.safeParse({ token })
  if (parsed.success) {
    try {
      await optOutDemoLead(parsed.data.token)
    } catch (err) {
      log.error({ err }, "demo lead opt-out failed")
      throw new HTTPException(503, { message: "Service temporarily unavailable" })
    }
  }
  return success(c, { optedOut: true })
})

/** The signup response: the new workspace and a session into it. */
async function visitorSession(
  c: Context,
  claim: { orgId: string; userId: string; slug: string },
  expiresAt: string,
  state: DemoProvisioningState,
  status: 201,
  extra: { needs: DemoNeed[]; verification: { sent: boolean; emailMasked: string } },
) {
  const tokens = await createSession(claim.userId, claim.orgId)
  const delivery = requestRefreshTokenDelivery(c)
  if (delivery.cookie) setRefreshTokenCookie(c, tokens.refreshToken)
  return success(
    c,
    {
      orgId: claim.orgId,
      orgSlug: claim.slug,
      userId: claim.userId,
      /** What the UI polls `statusUrl` until it reads "ready" or "failed". */
      state,
      statusUrl: `/api/demo/orgs/${claim.orgId}/status`,
      expiresAt,
      accessToken: tokens.accessToken,
      ...(delivery.body ? { refreshToken: tokens.refreshToken } : {}),
      needs: extra.needs,
      verification: extra.verification,
    },
    undefined,
    status,
  )
}

interface VisitorOrgInput {
  name: string
  email: string
  emailNormalized: string
  emailCapKey: string | null
  needs: DemoNeed[]
  /** The world `visitorWorld` derived; `needs` holds only what it shows. */
  worldId: DemoWorldId
  newsOptIn?: boolean
  entry?: DemoEntry
  signupNetwork: string
  ipBucket: string
  locale: ShippedLocale
  /** Where this start's signup key is held, when the client sent one. */
  signupRedisKey: string | null
  /** A signed load-harness start: a load org, from the warm pool like anyone. */
  synthetic: boolean
}

async function createVisitorOrg(c: Context, input: VisitorOrgInput) {
  const work = acquireVisitorWorkspace(input).then(async (org) => ({
    org,
    answer: await completeVisitorSignup(input, org),
  }))
  const signupRedisKey = input.signupRedisKey
  if (!signupRedisKey) {
    const { org, answer } = await work
    return visitorSession(c, org, org.expiresAt, org.state, 201, answer)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), demoSignupAnswer.budgetMs)
  })
  let outcome: Awaited<typeof work> | "late"
  try {
    outcome = await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
  if (outcome !== "late") {
    const { org, answer } = outcome
    return visitorSession(c, org, org.expiresAt, org.state, 201, answer)
  }
  // Past the budget: an honest "being prepared, ask again" now, the rest behind
  // the answer. The key stays pending until the work records the workspace, so
  // a retry meanwhile is told to wait too; a failure frees it for a fresh start.
  log.warn(
    { budgetMs: demoSignupAnswer.budgetMs, synthetic: input.synthetic },
    "demo signup past its answer budget: answered 'being prepared', finishing behind the answer",
  )
  void work.then(
    ({ org }) => log.info({ orgId: org.orgId }, "demo signup finished behind its answer"),
    async (err: unknown) => {
      log.error({ err }, "demo signup failed behind its answer; its signup key is freed")
      await releaseSignupKey(signupRedisKey)
    },
  )
  return signupStillCreating(c, demoSignupAnswer.retryAfterSeconds)
}

/** A workspace made the visitor's: from the warm pool, or a shell seeding behind the response. */
interface AcquiredWorkspace {
  orgId: string
  userId: string
  slug: string
  expiresAt: string
  state: DemoProvisioningState
}

/**
 * Make a workspace the visitor's, the one way both a signup and a start-over
 * do it. `expiresAt` overrides the fresh visitor TTL (a start-over keeps the
 * first workspace's end).
 */
async function acquireVisitorWorkspace(input: {
  name: string
  needs: DemoNeed[]
  /** The world to hand out: already checked against the worlds this box runs. */
  worldId: DemoWorldId
  locale: ShippedLocale
  synthetic: boolean
  expiresAt?: string
}): Promise<AcquiredWorkspace> {
  const { name, needs, locale, worldId } = input

  // THE WARM POOL FIRST (demo-pool.ts): a workspace seeded ahead of demand,
  // made the visitor's in one transaction. It is already complete, so nothing
  // runs behind this response and the visitor lands in the whole company.
  // A synthetic visitor takes the pool exactly like a person (spec A29), so a
  // stress run measures its hit rate; the claim flags it a load org at once.
  const pooled = await claimPooledOrg({
    worldId,
    name,
    locale,
    needs,
    synthetic: input.synthetic,
    expiresAt: input.expiresAt,
  })
  if (pooled) {
    // The pool seeds every need; the visitor sees the apps their picks need,
    // turned On, before their session exists.
    await fitPooledDemoWorld(pooled.orgId, needs, pooled.worldId, pooled.userId)
    const finishedAt = new Date().toISOString()
    await writeProvisioning({
      orgId: pooled.orgId,
      state: "ready",
      startedAt: finishedAt,
      finishedAt,
    })
    // One org left the pool: the refill job seeds its replacement, alone.
    void kickDemoPoolRefill()
    log.info(
      { orgId: pooled.orgId, userId: pooled.userId, worldId: pooled.worldId },
      "demo signup claimed a pooled workspace",
    )
    return {
      orgId: pooled.orgId,
      userId: pooled.userId,
      slug: pooled.slug,
      expiresAt: pooled.marker.expiresAt ?? visitorExpiry(),
      state: "ready",
    }
  }
  if (env.LIAISON_DEMO_POOL_SIZE > 0) {
    await recordDemoPoolMiss(worldId)
    void kickDemoPoolRefill()
  }

  const slug = demoOrgSlug(name)

  // WE create the org, not the seeder. The seeder keys on a slug and `ensureOrg`
  // treats a slug it already knows as an update, so a seeder running behind this
  // response adopts this org rather than racing it. Creating it here also means
  // the org is complete before anything slow starts, which is what makes a
  // failed seed a thinner demo instead of a wedged one -- and it is what keeps
  // the seeder's `credits: { initial: "25.00000000" }` off a workspace anyone
  // can mint, because `ensureOrg` only initialises credits when it CREATES.
  // The workspace's NAME is the fictional company's, never the caller's: what a
  // visitor is handed is that company, seeded, with themselves installed as its
  // CEO. There is nothing here for them to brand.
  //
  // The marker goes on before anything can act as this org, and the picks ride
  // on it as a UI hint for the web (scenario order). Nothing security-relevant
  // reads them there: the lead row is the truth.
  //
  // THE VISITOR IS THIS ORG'S ADMIN, and the only account in it that can be
  // signed into at all: the seven seeded people are left with a null
  // `password_hash` by the seeder. Its login is GENERATED, never the address
  // the visitor typed (see the header note), its password is random and never
  // shown (the session below is how they get in), and it is handed to the
  // seeder as the org's `owner` so the world is attached to THIS user rather
  // than to a persona. `ensureUser` gave the visitor their personal agent and
  // `@base` is ensured for an org the seeder created first.
  const now = new Date()
  const freshMarker = visitorMarker(env.LIAISON_DEMO_VISITOR_TTL_HOURS, now, needs, {
    worldId,
    worldMonth: demoWorldMonth(worldId, now),
  })
  const baseMarker = input.expiresAt ? { ...freshMarker, expiresAt: input.expiresAt } : freshMarker
  const marker = input.synthetic ? { ...baseMarker, synthetic: true } : baseMarker
  // A synthetic start's org is flagged a load org in the statement that writes
  // its marker, before anything can act as it: every effect it causes goes to the sink.
  const shell = await createVisitorOrgShell({
    slug,
    locale,
    marker,
    ownerName: name,
    orgName: demoWorldOrgName(worldId),
    loadHarness: input.synthetic,
  })
  const { orgId, userId } = shell

  const createdAt = new Date().toISOString()
  await writeProvisioning({ orgId, state: "provisioning", startedAt: createdAt })

  // Behind the response from here. Deliberately not awaited, and it cannot
  // throw into this request: `runSeedBehindResponse` owns its own failure.
  void runSeedBehindResponse({
    orgId,
    slug,
    locale,
    owner: { email: shell.login, name, password: shell.password },
    needs,
    worldId,
  })

  log.info({ orgId, userId, slug, worldId }, "demo org created; seeding behind the response")
  return {
    orgId,
    userId,
    slug,
    expiresAt: marker.expiresAt ?? visitorExpiry(),
    state: "provisioning",
  }
}

/** A hint on the marker: one that cannot be written never fails the signup. */
async function keepDoorEntry(orgId: string, entry: DemoEntry): Promise<void> {
  try {
    await recordDemoEntry(orgId, entry)
  } catch (err) {
    log.error({ err, orgId }, "failed to record the door's company answer")
  }
}

/**
 * What every signup does once it holds a workspace, pooled or fresh: the lead,
 * the first code and the signup key. The session is the caller's to mint, on
 * the response that carries it.
 */
async function completeVisitorSignup(
  input: VisitorOrgInput,
  org: {
    orgId: string
    userId: string
    slug: string
    expiresAt: string
    state: DemoProvisioningState
  },
) {
  const { name, email, needs, entry } = input
  const { orgId, userId, slug } = org

  // THE COMPANY QUESTION: the answer on the marker, with the workspace, and the
  // entry alone in the log, which is what outlives it to count who comes. The
  // visitor's words stay out of the log, and nothing here links it to the lead.
  if (entry) {
    await keepDoorEntry(orgId, entry)
    log.info({ demoEntry: entry.id }, "demo door entry")
  }

  // THE LEAD: the address as typed, under the notice the form showed. A lead
  // that cannot be written is logged loudly and does not fail the signup: the
  // visitor did nothing wrong and the workspace is already theirs.
  try {
    await recordDemoLead({
      email,
      name,
      demoOrgId: orgId,
      noticeVersion: DEMO_LEAD_NOTICE_VERSION,
      emailNormalized: input.emailNormalized,
      emailCapKey: input.emailCapKey,
      needs,
      signupNetwork: input.signupNetwork,
      newsOptIn: input.newsOptIn,
    })
  } catch (err) {
    log.error({ err, orgId, alert: "demo_lead_not_recorded" }, "failed to record a demo lead")
  }

  // THE FIRST CODE GOES OUT NOW, so it is in the inbox before the visitor
  // first asks an agent anything. A send that cannot happen (no mail channel,
  // a limit) does not fail the signup: the workspace is theirs, and the
  // verify band offers a resend.
  let verification: { sent: boolean; emailMasked: string }
  try {
    verification = await sendDemoCode(orgId, input.ipBucket)
  } catch (err) {
    if (!(err instanceof DemoVerifyError)) log.error({ err, orgId }, "demo code send failed")
    verification = { sent: false, emailMasked: maskDemoEmail(email) }
  }

  const answer = {
    needs,
    verification: { sent: verification.sent, emailMasked: verification.emailMasked },
  }
  // Recorded BEFORE the response is built: if the response never reaches the
  // caller, their retry with the same key finds this workspace (SIGNUP_KEY).
  if (input.signupRedisKey) {
    await recordSignupKey(input.signupRedisKey, { state: "done", orgId, userId, slug, ...answer })
  }
  return answer
}

/**
 * Populate the workspace after the visitor already has it. Never throws, never
 * retries, and always leaves a terminal state behind it, so a UI polling the
 * status route always stops.
 */
async function runSeedBehindResponse({
  orgId,
  slug,
  locale,
  owner,
  needs,
  worldId,
}: {
  orgId: string
  slug: string
  locale: ShippedLocale
  owner: { email: string; name: string; password: string }
  needs: DemoNeed[]
  worldId: DemoWorldId
}): Promise<void> {
  // THROUGH THE SEEDING GATE (demo-seed-gate.ts): at most
  // LIAISON_DEMO_SEED_CONCURRENCY seeds run at once on this box, so a burst
  // that has emptied the warm pool queues instead of seeding all at once. While
  // the visitor waits their turn the workspace reads "provisioning", and the
  // record is refreshed so a long wait is never mistaken for a dead seed.
  let startedAt = new Date().toISOString()
  let state: DemoProvisioningState = "failed"
  let failedParts: string[] = ["seed"]
  try {
    const seed = await withVisitorSeedSlot(
      orgId,
      async () => {
        startedAt = new Date().toISOString()
        await writeProvisioning({ orgId, state: "provisioning", startedAt })
        return seedDemoOrgData({
          orgSlug: slug,
          orgName: demoWorldOrgName(worldId),
          worldId,
          variant: "visitor",
          locale,
          owner,
          needs,
        })
      },
      () =>
        writeProvisioning({ orgId, state: "provisioning", startedAt: new Date().toISOString() }),
    )
    if (seed.ok) {
      state = "ready"
      failedParts = []
    } else {
      failedParts = seed.failedParts ?? ["seed"]
      log.error(
        { orgId, slug, failedParts, detail: seed.detail },
        "demo signup seed failed: the visitor is told so",
      )
    }
  } catch (err) {
    log.error({ err, orgId, slug }, "demo seeding failed behind the response")
  }
  try {
    // Whatever the seed did or did not do, a demo workspace holds no money.
    await zeroDemoOrgCredits(orgId)
  } catch (err) {
    log.error({ err, orgId }, "failed to zero a demo org's credits")
  }
  await writeProvisioning({
    orgId,
    state,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...(state === "failed" ? { failedParts } : {}),
  })
  log.info({ orgId, slug, state }, "demo org seeding finished")
}

function visitorExpiry(): string {
  return new Date(Date.now() + env.LIAISON_DEMO_VISITOR_TTL_HOURS * 3600_000).toISOString()
}

// ── Verification (demo-verification.ts) ─────────────────────────────────────

/**
 * The session's org, refused unless it is a visitor demo org. A non-demo org
 * (or the reserved one) is a 404 exactly as an unknown path is.
 */
async function requireVisitorOrg(c: Context<AppEnv>): Promise<string> {
  if (!isDemoModeEnabled()) throw new HTTPException(404, { message: "Not found" })
  const orgId = c.get("orgId")
  const marker = await loadDemoMarker(orgId)
  if (marker?.variant !== "visitor") throw new HTTPException(404, { message: "Not found" })
  return orgId
}

const sendCodeSchema = z.object({ turnstileToken: z.string().min(1).max(2048) }).strict()

/** Re-send the org's code. Session + a fresh Turnstile (`demo_code`). */
demoRoutes.post(
  "/verify/send",
  authMiddleware(env.JWT_SECRET),
  zValidator("json", sendCodeSchema),
  async (c) => {
    const orgId = await requireVisitorOrg(c)
    const { turnstileToken } = c.req.valid("json")
    const clientIp = demoClientIp(c)
    await requireTurnstile(c, turnstileToken, "demo_code", clientIp)
    try {
      const result = await sendDemoCode(orgId, demoPeerBucket(c))
      return success(c, { sent: result.sent, emailMasked: result.emailMasked })
    } catch (err) {
      if (err instanceof DemoVerifyError) throw verifyHttpError(c, err)
      throw err
    }
  },
)

/**
 * Two strict forms and nothing else: `{code}` needs the org session and
 * verifies that session's org only; `{token, turnstileToken}` is the link
 * page's Confirm press, unauthenticated, naming its org only through the HMAC
 * token. Neither accepts an org id (an extra field is a 400).
 */
const verifySchema = z.union([
  z
    .object({
      code: z
        .string()
        .trim()
        .regex(/^\d{6}$/),
    })
    .strict(),
  z
    .object({ token: z.string().min(16).max(512), turnstileToken: z.string().min(1).max(2048) })
    .strict(),
])

/** Link confirmations allowed per client IP per hour. */
const LINK_VERIFIES_PER_IP_PER_HOUR = 10

demoRoutes.post("/verify", zValidator("json", verifySchema), async (c) => {
  if (!isDemoModeEnabled()) throw new HTTPException(404, { message: "Not found" })
  const body = c.req.valid("json")
  try {
    if ("code" in body) {
      // Session required for the code form: run the auth middleware inline.
      await authMiddleware(env.JWT_SECRET)(c, async () => {})
      const orgId = await requireVisitorOrg(c)
      await verifyDemoCode(orgId, body.code, c.get("userId"))
      return success(c, { verified: true })
    }
    const clientIp = demoClientIp(c)
    await spendDemoBudget(c, redis, {
      identifier: `demo-verify-link:${demoPeerBucket(c)}`,
      limit: LINK_VERIFIES_PER_IP_PER_HOUR,
      windowSeconds: SIGNUP_WINDOW_SECONDS,
    })
    await requireTurnstile(c, body.turnstileToken, "demo_verify", clientIp)
    await verifyDemoLink(body.token)
    return success(c, { verified: true })
  } catch (err) {
    if (err instanceof DemoVerifyError) throw verifyHttpError(c, err)
    throw err
  }
})

// ── The load harness's sink read (lib/effect-sink.ts) ──────────────────────

/**
 * What a load org's effects left in the sink: its current demo code (so a
 * synthetic visitor can verify) and every effect key with how many times it
 * was seen (above 1 = a doubled effect). Signed with the box's
 * LOAD_HARNESS_KEY like the harness start, and only for a load org: without
 * the key, without a signature, or for any other org it is the same 404 as a
 * route that does not exist, so a real visitor's code is never readable. A
 * bad, stale or replayed signature is a 404 too (never a 403, which would
 * tell a scanner the harness is on). The query string is not signed,
 * so the route reads none.
 */
demoRoutes.get("/harness/orgs/:orgId/sink", async (c) => {
  const notFound = () => new HTTPException(404, { message: "Not found" })
  if (!isDemoModeEnabled()) throw notFound()
  const harness = await verifyHarnessContext(c)
  if (harness.kind === "absent") throw notFound()
  if (harness.kind === "refused") {
    log.warn({ reason: harness.reason }, "harness sink read with a refused signature")
    throw notFound()
  }
  const orgId = c.req.param("orgId")
  if (!UUID_RE.test(orgId) || !(await isLoadOrg(orgId))) throw notFound()
  const [demoCode, effects] = await Promise.all([sunkDemoCode(orgId), sinkEntriesForOrg(orgId)])
  return success(c, { orgId, demoCode, effects })
})

// The harness's flood and fan-out report (modules/demo/harness-routes.ts).
demoRoutes.route("/harness", harnessRoutes)

// ── Budget and the next-steps dialog ───────────────────────────────────────

/** The visitor's verification, budget and own keys, for the banner and /demo/budget. */
demoRoutes.get("/budget", authMiddleware(env.JWT_SECRET), async (c) => {
  const orgId = await requireVisitorOrg(c)
  const lead = await leadForDemoOrg(orgId)
  // Null exactly when the org has no verified identity (demo-budget.ts).
  const snapshot = await demoBudgetSnapshotForOrg(orgId)
  const settings = await withPrivilegedDb(orgId, "demo-budget-byok", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  const byok = Object.keys(settings.providerKeys ?? {}).filter((p) => !p.startsWith("custom:"))
  c.header("Cache-Control", "no-store")
  const marker = await loadDemoMarker(orgId)
  return success(c, {
    verified: snapshot !== null,
    emailMasked: lead ? maskDemoEmail(lead.email) : null,
    // The visitor's own address, shown back only to their own session: the
    // "next steps" dialog orders its options by it and fills the contact link.
    email: lead?.email ?? null,
    // The "next steps" dialog already opened by itself here (once per workspace).
    nextStepsShown: demoNextStepsShownOf(marker),
    // A code is waiting in the visitor's inbox (false: none could be sent).
    codeSent: snapshot === null ? await demoCodeOnRecord(orgId) : true,
    notifyManaged: lead?.notifyManagedAt != null,
    budget: {
      usedMicroEur: snapshot?.usedMicroEur ?? 0,
      capMicroEur: snapshot?.capMicroEur ?? demoBudgetCaps().email,
    },
    box: { exhausted: snapshot?.boxExhausted ?? false },
    byok,
  })
})

/** The recap line of the "next steps" dialog: what the visitor did here (demo-recap.ts). */
demoRoutes.get("/recap", authMiddleware(env.JWT_SECRET), async (c) => {
  const orgId = await requireVisitorOrg(c)
  const marker = await loadDemoMarker(orgId)
  const startedAt = marker?.createdAt ?? new Date().toISOString()
  c.header("Cache-Control", "no-store")
  return success(c, await demoRecapForOrg(orgId, c.get("userId"), startedAt))
})

/** The "next steps" dialog opened by itself: it does not again in this workspace. */
demoRoutes.post("/next-steps/shown", authMiddleware(env.JWT_SECRET), async (c) => {
  const orgId = await requireVisitorOrg(c)
  await recordDemoNextStepsShown(orgId)
  return success(c, { nextStepsShown: true })
})

/** The later opt-in to news: one click, verified leads only, idempotent. */
demoRoutes.post("/notify-managed", authMiddleware(env.JWT_SECRET), async (c) => {
  const orgId = await requireVisitorOrg(c)
  if (!(await setDemoLeadNotifyManaged(orgId))) {
    throw demoError(c, 403, "not_verified", "kernel.demo.verifyFirst")
  }
  return success(c, { notifyManaged: true })
})

// ── Start over ──────────────────────────────────────────────────────────────
//
// START_OVER. A visitor who has played some scenarios holds a used world (mails
// sent, requests approved, records made), and a scenario that got stuck there
// disturbs the next. "Start over" hands them a fresh one: the cheapest correct
// way the code has is the warm pool, so the visitor takes a new workspace
// exactly as a signup does (a pooled one, or a shell seeding behind the
// response), and the old one ends at once, for the hourly reaper to collect.
// Re-seeding in place would hold the visitor on an emptied workspace for the
// whole seed, and the nightly reset that does it is an operator's tool.
//
// What carries over is the PERSON, never the world: their name, picks and
// language, the lead (moved, so the confirmed address and the spend identity
// come along and the visitor needs no second code), and the workspace's end
// (kept, so starting over never lengthens a demo). The response is a signup's,
// a session into the new workspace, so the visitor stays signed in.
//
// What does NOT reset is spend: the budget is keyed on the confirmed mailbox and
// the signup network, which the moved lead keeps; only an operator clears it.
// That budget is the only per-visitor limit: starting over costs nothing the
// visitor could abuse. A start-over spends the box-wide signup ceiling and the
// live workspace cap like a signup, and never adds a live workspace: the old one
// ends in the same request.

/** How long one start-over holds its workspace against a second one. */
const START_OVER_LOCK_SECONDS = 60

demoRoutes.post("/start-over", authMiddleware(env.JWT_SECRET), async (c) => {
  const orgId = await requireVisitorOrg(c)
  const { marker, locale } = await loadDemoOrg(orgId)
  // A load-harness workspace has nobody to start over for.
  if (!marker || marker.synthetic === true) throw new HTTPException(404, { message: "Not found" })
  // An ended workspace is over; the door starts a new one.
  await assertDemoOrgActive(orgId)
  const lead = await leadForDemoOrg(orgId)
  if (!lead) throw demoError(c, 409, "no_lead", "kernel.demo.verifyNoLead")

  // One start-over at a time per workspace: a double click is one new world.
  const lockKey = `demo:start-over:${orgId}`
  let locked: string | null
  try {
    locked = await redis.set(lockKey, "1", "EX", START_OVER_LOCK_SECONDS, "NX")
  } catch (err) {
    log.error({ err, orgId }, "demo start-over lock failed, blocking request (fail-closed)")
    throw new HTTPException(503, { message: "Service temporarily unavailable" })
  }
  if (locked !== "OK") throw demoError(c, 409, "start_over_running", "kernel.demo.startOverRunning")
  try {
    await spendBoxSignupBudget(c)

    // The same world again, read off the old marker. The visitor administers
    // that org and could have rewritten its marker, so the world is honoured
    // only while this box runs it (else the default world), and the picks
    // only where that world shows them.
    const marked = demoWorldOf(marker)
    const worldId = enabledDemoWorlds().includes(marked) ? marked : DEMO_DEFAULT_WORLD
    const picked = demoNeedsSchema.safeParse(marker.needs ?? lead.needs)
    const needs = (picked.success ? picked.data : []).filter((need) =>
      DEMO_WORLD_NEEDS[worldId].includes(need),
    )
    const fresh = await acquireVisitorWorkspace({
      name: lead.name,
      needs,
      worldId,
      locale,
      synthetic: false,
      expiresAt: marker.expiresAt ?? undefined,
    })
    const entry = demoEntryOf(marker)
    if (entry) await keepDoorEntry(fresh.orgId, entry)
    // The old workspace is about to end with its progress: tell the Liaison team
    // (when on) which scenarios it played before the lead moves on.
    await forwardPlayedScenarios(lead.id, orgId)
    await moveDemoLead(lead.id, fresh.orgId)
    if (!(await endVisitorOrg(orgId))) {
      log.error(
        { orgId, alert: "demo_start_over_not_ended" },
        "start-over left the old workspace live",
      )
    }
    log.info(
      { from: orgId, to: fresh.orgId, state: fresh.state, worldId },
      "demo visitor started over",
    )
    return visitorSession(c, fresh, fresh.expiresAt, fresh.state, 201, {
      needs,
      verification: { sent: false, emailMasked: maskDemoEmail(lead.email) },
    })
  } finally {
    await redis.del(lockKey).catch((err: unknown) => {
      log.warn({ err, orgId }, "demo start-over lock release failed")
    })
  }
})

// THE DOOR'S WORLDS. Public, before any account exists: the door asks which
// worlds this box runs so its tiles and company step match what a start will
// open. It answers the world ids only, in the door's entry order, and nothing
// about any org. Whatever goes wrong reading them, the door is told the
// default world alone, which is what a start would open anyway.
demoRoutes.get("/door", (c) => {
  if (!isDemoModeEnabled()) throw new HTTPException(404, { message: "Not found" })
  let worlds: DemoWorldId[]
  try {
    worlds = enabledDemoWorlds()
  } catch (err) {
    log.error({ err }, "demo door: reading the enabled worlds failed; offering the default world")
    worlds = [DEMO_DEFAULT_WORLD]
  }
  return success(c, { worlds })
})

// THE WORKSPACE'S WORLD, for the visitor's own session: the example line, the
// limits panel and the welcome read it. 404 outside a visitor org.
demoRoutes.get(
  "/world",
  every(authMiddleware(env.JWT_SECRET), demoExpiryMiddleware()),
  async (c) => {
    const orgId = await requireVisitorOrg(c)
    const marker = await loadDemoMarker(orgId)
    return success(c, { worldId: demoWorldOf(marker) })
  },
)

// The visitor's guided scenarios (modules/demo/scenarios-routes.ts).
demoRoutes.route("/scenarios", demoScenariosRoutes)

/**
 * Register the demo limiter. Called from app.ts BEFORE the global `/api/*`
 * limiter so ordering is the registration order Hono runs.
 */
export function useDemoRateLimit(app: Hono<AppEnv>, redisClient: Redis): void {
  app.use("/api/demo/*", demoSignupRateLimiter(redisClient))
}

/** Mount the demo routes. Called from app.ts only when the gate is on. */
export function mountDemoRoutes(app: Hono<AppEnv>): void {
  app.route("/api/demo", demoRoutes)
}
