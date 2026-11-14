// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo WARM POOL (demo-pool.ts), against the real database and Redis and
// through the real signup route: it fills one seed at a time, a signup claims
// an already seeded workspace and becomes its owner, concurrent signups never
// share one, a claim kicks a refill, the reaper leaves pooled orgs alone, and
// a pool of size 0 is the signup exactly as it was.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { DemoNeed } from "@liaison/shared"
import { Hono } from "hono"
import { type AppEnv, apiBodyLimitMiddleware, apiRequestTimeoutMiddleware, app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import {
  forgetLoadOrgFlag,
  HARNESS_HEADER_NONCE,
  HARNESS_HEADER_SIGNATURE,
  HARNESS_HEADER_TIMESTAMP,
  isLoadOrg,
  LoadHarnessTestAccess,
  signHarnessRequest,
} from "~/lib/load-harness"
import { redis } from "~/lib/redis"
import { errorHandler } from "~/middleware/error-handler"
import {
  enableDemoDoorForTest,
  passingTurnstileToken,
  restoreDemoDoorEnv,
} from "~/modules/demo/demo-door.test-fixtures"
import { countVisitorOrgs, listExpiredDemoOrgs } from "~/modules/demo/demo-expiry"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo } from "~/modules/demo/demo-org"
import {
  claimPooledOrg,
  DEMO_POOL_OWNER_NAME,
  DemoPoolTestAccess,
  demoPoolBuildId,
  demoPoolDepth,
  demoPoolTargets,
  demoPoolWorld,
  pooledMarker,
  readDemoPoolStatus,
  refillDemoPool,
} from "~/modules/demo/demo-pool"
import { purgeDemoOrg } from "~/modules/demo/demo-reset"
import {
  DemoSeedGateTestAccess,
  releaseSeedSlot,
  tryAcquireRefillSeedSlot,
} from "~/modules/demo/demo-seed-gate"
import { DemoSeederTestAccess, setDemoSeeder } from "~/modules/demo/demo-seeder"
import { DemoWorldsTestAccess } from "~/modules/demo/demo-worlds"
import {
  DEMO_INTERNAL_LOGIN_DOMAIN,
  mountDemoRoutes,
  useDemoRateLimit,
} from "~/modules/demo/routes"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const demoApp = new Hono<AppEnv>()
demoApp.use("/api/*", apiBodyLimitMiddleware)
useDemoRateLimit(demoApp, redis)
demoApp.use("/api/*", apiRequestTimeoutMiddleware)
demoApp.onError(errorHandler)
mountDemoRoutes(demoApp)

let peer = 0
function nextPeer(): string {
  peer += 1
  return `203.0.113.${peer % 250}`
}

function signup(
  body: { name: string; email: string; needs?: DemoNeed[] },
  socketPeer: string,
  acceptLanguage = "en",
) {
  return demoApp.request("/api/demo/orgs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bun-socket-ip": socketPeer,
      "Accept-Language": acceptLanguage,
    },
    body: JSON.stringify({ needs: ["support"], turnstileToken: passingTurnstileToken(), ...body }),
  })
}

interface SignupBody {
  orgId: string
  orgSlug: string
  userId: string
  state: string
  expiresAt: string
  accessToken: string
}

async function readSignup(response: Response): Promise<SignupBody> {
  return ((await response.json()) as { data: SignupBody }).data
}

// ── The stub seeder ─────────────────────────────────────────────────────────
//
// Stands in for seed/tiers/demo/seed-demo.ts. Records which orgs it seeded and,
// for POOL seeds (the owner carries the pool's placeholder name), how many ran
// at once, so "one at a time" is measured rather than assumed.

const seededOrgIds = new Set<string>()
const poolSeedOwners = new Map<string, string>()
let poolSeedsInFlight = 0
let maxPoolSeedsInFlight = 0
let poolSeedCalls = 0
/** The world each pooled seed was asked for, in order. */
const poolSeedWorlds: string[] = []
/** While set, pooled seeds of that world fail. */
let failWorld: string | null = null
let failPoolSeeds = false
let seedsInFlight = 0
/** While set, every seed waits on it: a burst that cannot drain on its own. */
let seedHold: Promise<void> | null = null
let maxSeedsInFlight = 0

async function orgIdForSlug(slug: string): Promise<string> {
  const [row] = await sql<
    { id: string }[]
  >`SELECT id FROM kernel.organizations WHERE slug = ${slug}`
  if (!row) throw new Error(`no org for slug ${slug}`)
  return row.id
}

function installStubSeeder(): void {
  setDemoSeeder(async ({ orgSlug, owner, needs, worldId }) => {
    const orgId = await orgIdForSlug(orgSlug)
    const pooled = owner?.name === DEMO_POOL_OWNER_NAME
    if (pooled) {
      poolSeedCalls++
      poolSeedWorlds.push(worldId ?? "products")
      poolSeedsInFlight++
      maxPoolSeedsInFlight = Math.max(maxPoolSeedsInFlight, poolSeedsInFlight)
      // Every need: the pool seeds the Everything world.
      expect(needs?.length).toBe(7)
    }
    seedsInFlight++
    maxSeedsInFlight = Math.max(maxSeedsInFlight, seedsInFlight)
    try {
      await new Promise((r) => setTimeout(r, 40))
      if (seedHold) await seedHold
      if (pooled && failPoolSeeds) return { ok: false, orgId, detail: "stub failure" }
      if (pooled && failWorld !== null && (worldId ?? "products") === failWorld) {
        return { ok: false, orgId, detail: "stub world failure" }
      }
      if (pooled && owner) {
        // What the real seed does to the owner's agent: rows that name it.
        await sql`
          INSERT INTO kernel.agent_memory (org_id, user_id, type, name, description, content, owner_agent_id, required_scopes)
          SELECT a.org_id, a.owner_user_id, 'user', 'pool-stub', 'stub', 'remembered', a.id, '{}'
          FROM kernel.agents a JOIN kernel.users u ON u.id = a.owner_user_id
          WHERE a.org_id = ${orgId} AND a.kind = 'personal' AND u.email = ${owner.email}`
      }
      seededOrgIds.add(orgId)
      if (pooled && owner) poolSeedOwners.set(orgId, owner.email)
      return { ok: true, orgId }
    } finally {
      seedsInFlight--
      if (pooled) poolSeedsInFlight--
    }
  })
}

const fitCalls: Array<{ orgId: string; needs: readonly DemoNeed[]; ownerUserId?: string }> = []
let kicks = 0

/** Take every pooled org out of the pool, so each test starts from an empty one. */
async function drainPool(): Promise<void> {
  await sql`
    UPDATE kernel.organizations
    SET settings = jsonb_set(settings #- '{demo,pool}', '{demo,expiresAt}', '"2000-01-01T00:00:00.000Z"')
    WHERE settings->'demo'->>'pool' IS NOT NULL`
  invalidateDemoMarker()
}

async function markerOf(orgId: string): Promise<Record<string, unknown>> {
  const [row] = await sql<{ demo: Record<string, unknown> }[]>`
    SELECT settings->'demo' AS demo FROM kernel.organizations WHERE id = ${orgId}`
  return row?.demo ?? {}
}

const savedPoolSize = env.LIAISON_DEMO_POOL_SIZE
const savedWorlds = env.LIAISON_DEMO_WORLDS
const savedPoolSizes = env.LIAISON_DEMO_POOL_SIZES
const savedMaxAge = env.LIAISON_DEMO_POOL_MAX_AGE_HOURS
const savedSeedConcurrency = env.LIAISON_DEMO_SEED_CONCURRENCY
const savedVersion = env.LIAISON_VERSION

/** Pooled orgs' ids and builds, oldest first. */
async function pooledBuilds(): Promise<Array<{ id: string; build: string | null; pool: string }>> {
  return [
    ...(await sql<{ id: string; build: string | null; pool: string }[]>`
      SELECT id, settings->'demo'->>'build' AS build, settings->'demo'->>'pool' AS pool
      FROM kernel.organizations WHERE settings->'demo'->>'pool' IS NOT NULL
      ORDER BY created_at ASC`),
  ]
}

/**
 * Make pooled orgs look seeded before this process started (an hour ago),
 * still well inside the pool's maximum age.
 */
async function backdatePool(): Promise<void> {
  const before = JSON.stringify(new Date(Date.now() - 3600_000).toISOString())
  await sql`
    UPDATE kernel.organizations
    SET settings = jsonb_set(settings, '{demo,createdAt}', ${before}::jsonb)
    WHERE settings->'demo'->>'pool' IS NOT NULL`
  invalidateDemoMarker()
}

/**
 * Run `fn` with every seed held until `n` pooled seeds are in flight at once
 * (or 10 s pass), then let them go: proves the refill keeps `n` going together
 * however fast the shells are created.
 */
async function withSeedsHeldUntil<T>(n: number, fn: () => Promise<T>): Promise<T> {
  let release = () => {}
  seedHold = new Promise<void>((r) => {
    release = r
  })
  const running = fn()
  for (let i = 0; i < 400 && poolSeedsInFlight < n; i++) {
    await new Promise((r) => setTimeout(r, 25))
  }
  // Give a would-be extra seed the time to start before letting them go.
  await new Promise((r) => setTimeout(r, 100))
  seedHold = null
  release()
  return running
}

describe("demo warm pool", () => {
  beforeAll(async () => {
    await acquireTestLock()
    DemoModeTestAccess.set(true)
    enableDemoDoorForTest()
    installStubSeeder()
    DemoSeedGateTestAccess.setPollMs(10)
  })

  afterAll(async () => {
    await drainPool()
    env.LIAISON_DEMO_POOL_SIZE = savedPoolSize
    env.LIAISON_DEMO_WORLDS = savedWorlds
    env.LIAISON_DEMO_POOL_SIZES = savedPoolSizes
    env.LIAISON_DEMO_POOL_MAX_AGE_HOURS = savedMaxAge
    DemoWorldsTestAccess.setSeedable(null)
    env.LIAISON_DEMO_SEED_CONCURRENCY = savedSeedConcurrency
    env.LIAISON_VERSION = savedVersion
    DemoPoolTestAccess.setWorld(null)
    DemoSeedGateTestAccess.setPollMs(250)
    DemoPoolTestAccess.setKick(null)
    DemoModeTestAccess.set(null)
    restoreDemoDoorEnv()
    DemoSeederTestAccess.reset()
    await releaseTestLock()
  })

  beforeEach(async () => {
    await drainPool()
    await clearRedisPatterns(["ratelimit:*", "bruteforce:*", "demo:*"])
    env.LIAISON_DEMO_POOL_SIZE = 3
    env.LIAISON_DEMO_WORLDS = "products"
    env.LIAISON_DEMO_POOL_SIZES = ""
    env.LIAISON_DEMO_POOL_MAX_AGE_HOURS = 12
    DemoWorldsTestAccess.setSeedable(null)
    env.LIAISON_VERSION = "dev"
    DemoPoolTestAccess.setWorld(null)
    failPoolSeeds = false
    env.LIAISON_DEMO_SEED_CONCURRENCY = 2
    seedHold = null
    maxSeedsInFlight = 0
    poolSeedCalls = 0
    poolSeedWorlds.length = 0
    failWorld = null
    maxPoolSeedsInFlight = 0
    fitCalls.length = 0
    kicks = 0
    DemoPoolTestAccess.setKick(async () => {
      kicks++
    })
    DemoSeederTestAccess.setFitPooledWorld(async (orgId, needs, _worldId, ownerUserId) => {
      fitCalls.push({ orgId, needs, ownerUserId })
      return { appsOff: [], supportRoutineOff: false }
    })
  })

  afterEach(async () => {
    invalidateDemoMarker()
  })

  it("fills the pool to its size, one seed at a time, and a second run finds the lock", async () => {
    // Three runs at once, as three API processes (or a burst of kicks) would.
    const outcomes = await Promise.all([refillDemoPool(), refillDemoPool(), refillDemoPool()])
    const ran = outcomes.filter((o) => !o.skipped)
    expect(ran).toHaveLength(1)
    expect(outcomes.filter((o) => o.skipped === "locked")).toHaveLength(2)
    expect(ran[0]?.seeded).toBe(3)
    expect(poolSeedCalls).toBe(3)
    expect(maxPoolSeedsInFlight).toBe(1)
    expect(await demoPoolDepth()).toMatchObject({ ready: 3, seeding: 0 })

    // A full pool seeds nothing more.
    const again = await refillDemoPool()
    expect(again.seeded).toBe(0)
    expect(poolSeedCalls).toBe(3)

    // A pooled org is a visitor org with no clock and no owner yet: no lead.
    const pooled = await sql<{ id: string; demo: Record<string, unknown> }[]>`
      SELECT id, settings->'demo' AS demo FROM kernel.organizations
      WHERE settings->'demo'->>'pool' = 'ready'`
    expect(pooled).toHaveLength(3)
    for (const row of pooled) {
      expect(row.demo.variant).toBe("visitor")
      expect(row.demo.expiresAt).toBeNull()
      const [leads] = await sql<{ n: string }[]>`
        SELECT count(*) AS n FROM kernel.demo_leads WHERE demo_org_id = ${row.id}`
      expect(Number(leads?.n)).toBe(0)
    }
  })

  it("seeds in parallel up to every gate slot but one, never past the size", async () => {
    env.LIAISON_DEMO_SEED_CONCURRENCY = 4
    env.LIAISON_DEMO_POOL_SIZE = 5
    const outcome = await withSeedsHeldUntil(3, refillDemoPool)
    expect(outcome.seeded).toBe(5)
    expect(outcome.failed).toBe(0)
    expect(poolSeedCalls).toBe(5)
    // Three at once: the fourth slot stays free for a visitor on an empty pool.
    expect(maxPoolSeedsInFlight).toBe(3)
    expect(await demoPoolDepth()).toMatchObject({ ready: 5, seeding: 0 })
    // Every slot of the gate is back.
    const leases = []
    for (let i = 0; i < 4; i++) leases.push(await tryAcquireRefillSeedSlot())
    expect(leases.every((l) => l !== null)).toBe(true)
    for (const l of leases) if (l) await releaseSeedSlot(l)
  })

  it("a process that is shutting down starts no new seed and lets its running seeds finish", async () => {
    env.LIAISON_DEMO_SEED_CONCURRENCY = 4
    env.LIAISON_DEMO_POOL_SIZE = 5
    try {
      // Already shutting down: no seed at all, and the refill lock is free after.
      DemoPoolTestAccess.setShuttingDown(() => true)
      const idle = await refillDemoPool()
      expect(idle.seeded).toBe(0)
      expect(poolSeedCalls).toBe(0)
      expect(await redis.get(DemoPoolTestAccess.keys.REFILL_LOCK_KEY)).toBeNull()

      // Shutdown begins while three seeds run: they finish, nothing new starts.
      let down = false
      DemoPoolTestAccess.setShuttingDown(() => down)
      const outcome = await withSeedsHeldUntil(3, async () => {
        const run = refillDemoPool()
        for (let i = 0; i < 400 && poolSeedsInFlight < 3; i++) {
          await new Promise((r) => setTimeout(r, 10))
        }
        down = true
        return run
      })
      expect(outcome.seeded).toBe(3)
      expect(poolSeedCalls).toBe(3)
      expect(await demoPoolDepth()).toMatchObject({ ready: 3, seeding: 0 })
      expect(await redis.get(DemoPoolTestAccess.keys.REFILL_LOCK_KEY)).toBeNull()
    } finally {
      DemoPoolTestAccess.setShuttingDown(null)
    }
  })

  it("a failed seed among parallel ones starts no further seed and backs off once", async () => {
    env.LIAISON_DEMO_SEED_CONCURRENCY = 4
    env.LIAISON_DEMO_POOL_SIZE = 5
    failPoolSeeds = true
    const outcome = await withSeedsHeldUntil(3, refillDemoPool)
    // The first three were already running together when the first failed.
    expect(poolSeedCalls).toBe(3)
    expect(outcome.failed).toBe(3)
    expect(outcome.seeded).toBe(0)
    expect(await demoPoolDepth()).toMatchObject({ ready: 0, seeding: 0 })
    const backoff = JSON.parse(
      (await redis.get(DemoPoolTestAccess.keys.backoffKey("products"))) ?? "{}",
    )
    expect(backoff.failures).toBe(1)
    expect((await refillDemoPool()).skipped).toBe("backoff")
  })

  it("a signup claims an already seeded workspace, as its owner, with the lead and the expiry", async () => {
    await refillDemoPool()
    const before = Date.now()
    const response = await signup(
      { name: "Ada Lovelace", email: "Ada@Example.com", needs: ["support", "sales"] },
      nextPeer(),
      "fr-FR,fr;q=0.9",
    )
    expect(response.status).toBe(201)
    const data = await readSignup(response)

    // Already seeded: the visitor never waits on a seed.
    expect(data.state).toBe("ready")
    expect(seededOrgIds.has(data.orgId)).toBe(true)

    // The owner is the account the seed attached the world to, now the visitor's.
    const [owner] = await sql<{ email: string; name: string; role: string }[]>`
      SELECT u.email, u.name, r.name AS role FROM kernel.users u
      JOIN kernel.user_roles ur ON ur.user_id = u.id
      JOIN kernel.roles r ON r.id = ur.role_id
      WHERE u.id = ${data.userId}`
    expect(owner?.email).toBe(poolSeedOwners.get(data.orgId) ?? "missing")
    expect(owner?.email.endsWith(`@${DEMO_INTERNAL_LOGIN_DOMAIN}`)).toBe(true)
    expect(owner?.name).toBe("Ada Lovelace")
    expect(owner?.role).toBe("admin")

    // Its marker is the visitor's: no pool, the needs, an expiry from NOW.
    const marker = await markerOf(data.orgId)
    expect(marker.pool).toBeUndefined()
    expect(marker.variant).toBe("visitor")
    expect(marker.needs).toEqual(["support", "sales"])
    expect(marker.expiresAt).toBe(data.expiresAt)
    const ttlMs = env.LIAISON_DEMO_VISITOR_TTL_HOURS * 3600_000
    expect(Date.parse(data.expiresAt)).toBeGreaterThanOrEqual(before + ttlMs - 1000)
    expect(Date.parse(data.expiresAt)).toBeLessThanOrEqual(Date.now() + ttlMs + 1000)

    // The visitor's OWN agent, under the handle their name gives it, exactly
    // as at signup, and what the seed attached to the placeholder's agent is
    // now attached to it. The placeholder's agent is gone.
    const personal = await sql<{ id: string; handle: string }[]>`
      SELECT id, handle FROM kernel.agents
      WHERE org_id = ${data.orgId} AND kind = 'personal' AND owner_user_id = ${data.userId}`
    expect(personal.map((a) => a.handle)).toEqual(["@adas-agent"])
    const memory = await sql<{ owner_agent_id: string }[]>`
      SELECT owner_agent_id FROM kernel.agent_memory WHERE org_id = ${data.orgId} AND name = 'pool-stub'`
    expect(memory.map((m) => m.owner_agent_id)).toEqual([personal[0]?.id ?? "missing"])
    const placeholders = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM kernel.agents WHERE org_id = ${data.orgId} AND handle LIKE '@unclaimed%'`
    expect(Number(placeholders[0]?.n)).toBe(0)

    // The visitor's language, and the world fitted to their picks, the owner's attention with it.
    const [org] = await sql<{ locale: string }[]>`
      SELECT default_locale AS locale FROM kernel.organizations WHERE id = ${data.orgId}`
    expect(org?.locale).toBe("fr")
    expect(fitCalls).toEqual([
      { orgId: data.orgId, needs: ["support", "sales"], ownerUserId: data.userId },
    ])

    // The lead, as typed.
    const leads = await sql<{ email: string; name: string }[]>`
      SELECT email, name FROM kernel.demo_leads WHERE demo_org_id = ${data.orgId}`
    expect([...leads]).toEqual([{ email: "ada@example.com", name: "Ada Lovelace" }])

    // The session works on the real app, as the owner.
    const me = await app.request("/api/users/me", {
      headers: { Authorization: `Bearer ${data.accessToken}` },
    })
    expect(me.status).toBe(200)
    expect(((await me.json()) as { data: { id: string } }).data.id).toBe(data.userId)

    // One fewer in the pool, and a refill was asked for.
    expect(await demoPoolDepth()).toMatchObject({ ready: 2, seeding: 0 })
    expect(kicks).toBe(1)
  })

  // Spec A29: a signed load-harness start takes the pool exactly like a visitor
  // (so a stress run measures the pool's hit rate), and the claim makes it a
  // load org in the same statement that hands it over, before anything else
  // can read it.
  it("a signed load-harness start claims a pooled workspace, flagged a load org by the claim itself", async () => {
    const KEY = "p".repeat(48)
    LoadHarnessTestAccess.setKey(KEY)
    try {
      await refillDemoPool()
      const raw = JSON.stringify({
        name: "Load",
        email: `load-${crypto.randomUUID().slice(0, 8)}@load.invalid`,
        needs: ["support"],
        turnstileToken: "-",
      })
      const timestamp = Date.now()
      const nonce = `n${crypto.randomUUID().replaceAll("-", "")}`
      const response = await demoApp.request("/api/demo/orgs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bun-socket-ip": nextPeer(),
          [HARNESS_HEADER_TIMESTAMP]: String(timestamp),
          [HARNESS_HEADER_NONCE]: nonce,
          [HARNESS_HEADER_SIGNATURE]: signHarnessRequest(
            { method: "POST", path: "/api/demo/orgs", timestamp, nonce, body: raw },
            KEY,
          ),
        },
        body: raw,
      })
      expect(response.status).toBe(201)
      const data = await readSignup(response)
      expect(data.state).toBe("ready")
      expect(seededOrgIds.has(data.orgId)).toBe(true)
      expect(await demoPoolDepth()).toMatchObject({ ready: 2, seeding: 0 })
      // The flag is on the row (not only in this process's cache), with the marker.
      const [row] = await sql<
        { settings: { loadHarness?: unknown; demo?: { synthetic?: unknown } } }[]
      >`
        SELECT settings FROM kernel.organizations WHERE id = ${data.orgId}`
      expect(row?.settings.loadHarness).toBe(true)
      expect(row?.settings.demo?.synthetic).toBe(true)
      forgetLoadOrgFlag(data.orgId)
      expect(await isLoadOrg(data.orgId)).toBe(true)
      // It counts as synthetic, never as a visitor.
      const { synthetic } = await countVisitorOrgs()
      expect(synthetic).toBeGreaterThanOrEqual(1)
    } finally {
      LoadHarnessTestAccess.setKey(undefined)
    }
  })

  it("concurrent signups never share a workspace, and the overflow falls back to a fresh seed", async () => {
    await refillDemoPool()
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        signup({ name: `Visitor ${i}`, email: `visitor${i}@example.com` }, nextPeer()),
      ),
    )
    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201))
    const bodies = await Promise.all(responses.map(readSignup))
    const orgIds = bodies.map((b) => b.orgId)
    expect(new Set(orgIds).size).toBe(10)
    expect(new Set(bodies.map((b) => b.userId)).size).toBe(10)

    const claimed = bodies.filter((b) => b.state === "ready")
    const fresh = bodies.filter((b) => b.state === "provisioning")
    expect(claimed).toHaveLength(3)
    expect(fresh).toHaveLength(7)
    expect(await demoPoolDepth()).toMatchObject({ ready: 0, seeding: 0 })

    // Each claimed org went to exactly one visitor, who owns it.
    for (const b of claimed) {
      const [owner] = await sql<
        { name: string }[]
      >`SELECT name FROM kernel.users WHERE id = ${b.userId}`
      expect(owner?.name.startsWith("Visitor ")).toBe(true)
    }
    // The misses are counted for sizing the pool.
    expect(Number(await redis.get(DemoPoolTestAccess.keys.EMPTY_COUNT_KEY))).toBe(7)

    // Let the fallback seeds behind the responses finish before the next test.
    for (let i = 0; i < 100; i++) {
      if (fresh.every((b) => seededOrgIds.has(b.orgId))) break
      await new Promise((r) => setTimeout(r, 50))
    }
  })

  it("a claim triggers a refill that seeds exactly the replacement", async () => {
    await refillDemoPool()
    expect(poolSeedCalls).toBe(3)
    const response = await signup({ name: "Grace Hopper", email: "grace@example.com" }, nextPeer())
    expect((await readSignup(response)).state).toBe("ready")
    expect(kicks).toBe(1)
    expect(await demoPoolDepth()).toMatchObject({ ready: 2, seeding: 0 })

    // What the kick runs on the job worker.
    const outcome = await refillDemoPool()
    expect(outcome.seeded).toBe(1)
    expect(poolSeedCalls).toBe(4)
    expect(await demoPoolDepth()).toMatchObject({ ready: 3, seeding: 0 })
  })

  it("the reaper and the signup cap never count or take a pooled workspace", async () => {
    await refillDemoPool()
    const pooled = await sql<{ id: string }[]>`
      SELECT id FROM kernel.organizations WHERE settings->'demo'->>'pool' = 'ready'`
    expect(pooled).toHaveLength(3)
    const ids = new Set(pooled.map((r) => r.id))

    // Even with a past expiry written onto one, pooled orgs are skipped.
    const first = pooled[0]?.id ?? ""
    await sql`
      UPDATE kernel.organizations
      SET settings = jsonb_set(settings, '{demo,expiresAt}', '"2001-01-01T00:00:00.000Z"')
      WHERE id = ${first}`
    invalidateDemoMarker()
    const farFuture = new Date(Date.now() + 10 * 365 * 24 * 3600_000)
    const expired = await listExpiredDemoOrgs(farFuture, 100_000)
    expect(expired.filter((o) => ids.has(o.orgId))).toEqual([])
    expect(await purgeDemoOrg(first, farFuture)).toEqual({ purged: false, refusal: "pooled" })

    // Real visitors and the load harness's synthetic workspaces are counted apart.
    const { total, synthetic } = await countVisitorOrgs()
    const [visitors] = await sql<{ n: string; synthetic: string }[]>`
      SELECT count(*) FILTER (WHERE settings->'demo'->>'synthetic' IS DISTINCT FROM 'true') AS n,
             count(*) FILTER (WHERE settings->'demo'->>'synthetic' = 'true') AS synthetic
      FROM kernel.organizations
      WHERE settings->'demo'->>'variant' = 'visitor' AND settings->'demo'->'pool' IS NULL`
    expect(total).toBe(Number(visitors?.n))
    expect(synthetic).toBe(Number(visitors?.synthetic))
  })

  it("a failed pool seed backs off, says so, and its org is handed to the reaper", async () => {
    failPoolSeeds = true
    const outcome = await refillDemoPool()
    expect(outcome.failed).toBe(1)
    expect(outcome.seeded).toBe(0)
    expect(poolSeedCalls).toBe(1)
    expect(await demoPoolDepth()).toMatchObject({ ready: 0, seeding: 0 })

    const status = JSON.parse((await redis.get(DemoPoolTestAccess.keys.STATUS_KEY)) ?? "{}")
    expect(status.lastError).toBe("stub failure")

    // Backing off: the next tick seeds nothing.
    expect((await refillDemoPool()).skipped).toBe("backoff")
    expect(poolSeedCalls).toBe(1)

    // The broken org is an ordinary expired visitor org now, the reaper's.
    const expired = await listExpiredDemoOrgs()
    const [broken] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.organizations
      WHERE settings->'demo'->>'variant' = 'visitor' AND settings->'demo'->'pool' IS NULL
      ORDER BY created_at DESC LIMIT 1`
    expect(expired.some((o) => o.orgId === broken?.id)).toBe(true)

    // The backoff lapses and the next run seeds again.
    failPoolSeeds = false
    const later = await refillDemoPool(() => Date.now() + 60 * 60_000)
    expect(later.seeded).toBe(3)
  })

  it("an empty pool queues a burst: at most LIAISON_DEMO_SEED_CONCURRENCY seeds at once, every visitor seeded", async () => {
    // The pool is on but empty, and the refill never runs here. Every seed
    // is held until the whole burst has arrived.
    let release = () => {}
    seedHold = new Promise<void>((r) => {
      release = r
    })
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        signup({ name: `Burst ${i}`, email: `burst${i}@example.com` }, nextPeer()),
      ),
    )
    const bodies = await Promise.all(responses.map(readSignup))
    expect(bodies.map((b) => b.state)).toEqual(Array(10).fill("provisioning"))

    // Two seed, eight wait in line, in "provisioning".
    const queue = DemoSeedGateTestAccess.keys.QUEUE_KEY
    for (let i = 0; i < 400 && (await redis.llen(queue)) < 8; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(await redis.llen(queue)).toBe(8)
    expect(seedsInFlight).toBe(2)

    // While visitors wait, the refill does not take a slot from them.
    const refill = await refillDemoPool()
    expect(refill.skipped).toBe("busy")
    expect(poolSeedCalls).toBe(0)

    seedHold = null
    release()
    for (let i = 0; i < 800; i++) {
      if (bodies.every((b) => seededOrgIds.has(b.orgId))) break
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(bodies.filter((b) => !seededOrgIds.has(b.orgId))).toEqual([])
    expect(maxSeedsInFlight).toBe(2)
    expect(await redis.llen(DemoSeedGateTestAccess.keys.QUEUE_KEY)).toBe(0)

    // Every visitor's workspace reaches "ready".
    for (const b of bodies) {
      let state = "provisioning"
      for (let i = 0; i < 100 && state === "provisioning"; i++) {
        const res = await demoApp.request(`/api/demo/orgs/${b.orgId}/status`, {
          headers: { "x-bun-socket-ip": nextPeer() },
        })
        state = ((await res.json()) as { data: { state: string } }).data.state
        if (state === "provisioning") await new Promise((r) => setTimeout(r, 20))
      }
      expect(state).toBe("ready")
    }
  }, 60_000)

  it("a killed holder's seed slot frees within one short lease, while a live holder keeps it", async () => {
    // Production lease: well under a seed's deadline (a deploy's dead slots
    // used to stay taken for the whole of it).
    const held = await tryAcquireRefillSeedSlot()
    expect(held).not.toBeNull()
    if (!held) return
    const ttl = await redis.pttl(held.key)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(30_000)
    await releaseSeedSlot(held)

    DemoSeedGateTestAccess.setSlotLeaseMs(300)
    try {
      const live = await tryAcquireRefillSeedSlot()
      const dead = await tryAcquireRefillSeedSlot()
      expect(live).not.toBeNull()
      expect(dead).not.toBeNull()
      if (!live || !dead) return
      DemoSeedGateTestAccess.abandon(dead)
      await new Promise((r) => setTimeout(r, 900))
      // The live holder renewed past three lease TTLs; the dead one lapsed.
      expect(await redis.get(live.key)).toBe(live.token)
      expect(await redis.get(dead.key)).toBeNull()
      await releaseSeedSlot(live)
      expect(await redis.get(live.key)).toBeNull()
    } finally {
      DemoSeedGateTestAccess.setSlotLeaseMs(30_000)
    }
  })

  it("the refill lock is a short lease its live run renews, so a killed run frees it quickly", async () => {
    const lockKey = DemoPoolTestAccess.keys.REFILL_LOCK_KEY
    const held = async (): Promise<{ run: Promise<unknown>; release: () => void }> => {
      let release = () => {}
      seedHold = new Promise<void>((r) => {
        release = r
      })
      const run = refillDemoPool()
      for (let i = 0; i < 200 && !(await redis.exists(lockKey)); i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
      return { run, release }
    }
    // Production lease: a run killed with its process frees the lock within
    // 30 s (it used to hold for a seed's whole deadline, ~16 min).
    const first = await held()
    const prodTtl = await redis.pttl(lockKey)
    expect(prodTtl).toBeGreaterThan(0)
    expect(prodTtl).toBeLessThanOrEqual(30_000)
    seedHold = null
    first.release()
    await first.run
    await redis.del(lockKey)
    // Room for more pooled seeds (beforeEach puts the size back).
    env.LIAISON_DEMO_POOL_SIZE = 6

    DemoPoolTestAccess.setRefillLockTtlMs(300)
    let release = () => {}
    try {
      const second = await held()
      release = second.release
      const run = second.run
      const ttl = await redis.pttl(lockKey)
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(300)
      // Past three leases, the live run still holds it.
      await new Promise((r) => setTimeout(r, 900))
      expect(await redis.exists(lockKey)).toBe(1)
      seedHold = null
      release()
      await run
      expect(await redis.exists(lockKey)).toBe(0)
    } finally {
      seedHold = null
      release()
      DemoPoolTestAccess.setRefillLockTtlMs(30_000)
    }
  })

  it("a killed refill run's half seeded shells stop counting at the next run, not after a seed's deadline", async () => {
    // A worker killed mid refill (out of memory, a deploy) a minute ago left
    // two shells in `seeding`, marked with its run; one older shell carries no
    // run at all (written before markers had one) and keeps the old rule.
    const shell = async (run: string | null): Promise<string> => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Half seeded', ${`half-seeded-${crypto.randomUUID().slice(0, 8)}`})
        RETURNING id`
      const orgId = row?.id as string
      await markOrgAsDemo(
        orgId,
        pooledMarker(
          "seeding",
          new Date(Date.now() - 60_000),
          demoPoolBuildId(),
          demoPoolWorld("products"),
          run,
          "products",
        ),
      )
      return orgId
    }
    const dead = [await shell("killed-run"), await shell("killed-run")]
    const legacy = await shell(null)
    invalidateDemoMarker()
    expect(await demoPoolDepth()).toMatchObject({ ready: 0, seeding: 3 })

    const outcome = await refillDemoPool()
    // The dead run's shells went to the reaper and the pool refilled around
    // them; the legacy one still counts until its deadline.
    expect(outcome.seeded).toBe(2)
    expect(await demoPoolDepth()).toMatchObject({ ready: 2, seeding: 1 })
    for (const orgId of dead) {
      const marker = await markerOf(orgId)
      expect(marker.pool).toBeUndefined()
      expect(Date.parse(String(marker.expiresAt))).toBeLessThan(Date.now())
    }
    expect((await markerOf(legacy)).pool).toBe("seeding")
  })

  it("a waiting visitor goes before the refill even when a slot is free", async () => {
    const { QUEUE_KEY: queue, WAITER_PREFIX } = DemoSeedGateTestAccess.keys
    await redis.set(`${WAITER_PREFIX}someone-waiting`, "1", "PX", 15_000)
    await redis.rpush(queue, "someone-waiting")
    try {
      expect(await tryAcquireRefillSeedSlot()).toBeNull()
      expect((await refillDemoPool()).skipped).toBe("busy")
      expect(poolSeedCalls).toBe(0)
    } finally {
      await redis.del(queue, `${WAITER_PREFIX}someone-waiting`)
    }
    const lease = await tryAcquireRefillSeedSlot()
    expect(lease).not.toBeNull()
    if (lease) await releaseSeedSlot(lease)
  })

  it("while visitors wait, the refill keeps a third of the slots and the visitors get the rest", async () => {
    env.LIAISON_DEMO_SEED_CONCURRENCY = 6
    env.LIAISON_DEMO_POOL_SIZE = 5
    const { QUEUE_KEY: queue, WAITER_PREFIX } = DemoSeedGateTestAccess.keys
    await redis.set(`${WAITER_PREFIX}someone-waiting`, "1", "PX", 15_000)
    await redis.rpush(queue, "someone-waiting")
    try {
      // The gate: two refill leases while someone waits, then no more.
      const held = [await tryAcquireRefillSeedSlot(), await tryAcquireRefillSeedSlot()]
      expect(held.every((l) => l !== null)).toBe(true)
      expect(await tryAcquireRefillSeedSlot()).toBeNull()
      for (const l of held) if (l) await releaseSeedSlot(l)

      // A refill run under a waiting visitor seeds the whole pool, two at once,
      // instead of standing aside until the queue is empty.
      const outcome = await withSeedsHeldUntil(2, refillDemoPool)
      expect(outcome.skipped).toBeUndefined()
      expect(outcome.seeded).toBe(5)
      expect(maxPoolSeedsInFlight).toBe(2)
    } finally {
      await redis.del(queue, `${WAITER_PREFIX}someone-waiting`)
    }
    // Nobody waiting: the refill runs at its full parallelism again.
    const leases = []
    for (let i = 0; i < 5; i++) leases.push(await tryAcquireRefillSeedSlot())
    expect(leases.every((l) => l !== null)).toBe(true)
    for (const l of leases) if (l) await releaseSeedSlot(l)
  })

  it("dead waiters left by killed processes never keep the refill out: the pool refills", async () => {
    // A deploy killed every waiting process: their tickets stay in the list,
    // their heartbeats lapse, and no live waiter is left to prune them.
    const { QUEUE_KEY: queue, WAITER_PREFIX } = DemoSeedGateTestAccess.keys
    await redis.rpush(queue, ...Array.from({ length: 300 }, (_, i) => `dead-${i}`))
    try {
      const lease = await tryAcquireRefillSeedSlot()
      expect(lease).not.toBeNull()
      if (lease) await releaseSeedSlot(lease)
      expect(await redis.llen(queue)).toBe(0)
      const run = await refillDemoPool()
      expect(run.skipped).toBeUndefined()
      expect(poolSeedCalls).toBeGreaterThan(0)

      // A live waiter behind dead ones still goes first, and stays queued.
      await redis.rpush(queue, "dead-a", "dead-b", "live-one")
      await redis.set(`${WAITER_PREFIX}live-one`, "1", "PX", 15_000)
      expect(await tryAcquireRefillSeedSlot()).toBeNull()
      expect(await redis.lrange(queue, 0, -1)).toEqual(["live-one"])
    } finally {
      await redis.del(queue, `${WAITER_PREFIX}live-one`)
    }
  })

  it("the running build's world fingerprint is computed from inputs that all exist", () => {
    // A missing input (a renamed fixture folder) would silently drop the
    // fingerprint and with it every deploy's kept pool.
    expect(demoPoolWorld("products")).toMatch(/^[0-9a-f]{32}$/)
  })

  it("a deploy that leaves the seeded world unchanged keeps the older build's ready workspaces claimable", async () => {
    env.LIAISON_VERSION = "build-old"
    await refillDemoPool()
    const old = await pooledBuilds()
    expect(old.map((r) => r.build)).toEqual(["build-old", "build-old", "build-old"])
    await backdatePool()

    // A deploy whose schema and seed fixtures are the old build's: the old
    // worlds are exactly what this build would seed, so they stay its pool.
    env.LIAISON_VERSION = "build-new"
    expect(await demoPoolDepth()).toMatchObject({ ready: 3, seeding: 0 })
    const outcome = await refillDemoPool()
    expect(outcome.seeded).toBe(0)
    expect((await pooledBuilds()).map((r) => r.id)).toEqual(old.map((r) => r.id))
    const expired = await listExpiredDemoOrgs()
    expect(old.some((r) => expired.some((o) => o.orgId === r.id))).toBe(false)

    const response = await signup({ name: "Ada Lovelace", email: "ada@example.com" }, nextPeer())
    const data = await readSignup(response)
    expect(data.state).toBe("ready")
    expect(data.orgId).toBe(old[0]?.id ?? "missing")
  })

  it("an older build's ready workspace with no world fingerprint is retired, as before", async () => {
    env.LIAISON_VERSION = "build-old"
    env.LIAISON_DEMO_POOL_SIZE = 1
    await refillDemoPool()
    const [row] = await pooledBuilds()
    // A marker written before pooled orgs carried their world.
    await sql`
      UPDATE kernel.organizations SET settings = settings #- '{demo,world}'
      WHERE id = ${row?.id ?? ""}`
    invalidateDemoMarker()
    await backdatePool()

    env.LIAISON_VERSION = "build-new"
    expect(await demoPoolDepth()).toMatchObject({ ready: 0, seeding: 0 })
    expect((await refillDemoPool()).seeded).toBe(1)
    expect((await markerOf(row?.id ?? "")).pool).toBeUndefined()
  })

  it("an older build's ready workspaces are of another world are never claimed, and the refill retires them to the reaper", async () => {
    DemoPoolTestAccess.setWorld("world-old")
    env.LIAISON_VERSION = "build-old"
    await refillDemoPool()
    const old = await pooledBuilds()
    expect(old.map((r) => r.build)).toEqual(["build-old", "build-old", "build-old"])
    await backdatePool()

    // A deploy that changes the seeded world: the old worlds are not its pool.
    DemoPoolTestAccess.setWorld("world-new")
    env.LIAISON_VERSION = "build-new"
    expect(await demoPoolDepth()).toMatchObject({ ready: 0, seeding: 0 })
    const miss = await signup({ name: "Early Bird", email: "early@example.com" }, nextPeer())
    expect(miss.status).toBe(201)
    const missed = await readSignup(miss)
    expect(missed.state).toBe("provisioning")
    expect(old.some((r) => r.id === missed.orgId)).toBe(false)

    // The refill hands every old one to the reaper and seeds the new build's.
    const outcome = await refillDemoPool()
    expect(outcome.seeded).toBe(3)
    const expired = await listExpiredDemoOrgs()
    for (const row of old) {
      const marker = await markerOf(row.id)
      expect(marker.pool).toBeUndefined()
      expect(expired.some((o) => o.orgId === row.id)).toBe(true)
    }
    const fresh = await pooledBuilds()
    expect(fresh.map((r) => r.build)).toEqual(["build-new", "build-new", "build-new"])

    // A signup now claims one the running build seeded.
    const response = await signup({ name: "Grace Hopper", email: "grace@example.com" }, nextPeer())
    const data = await readSignup(response)
    expect(data.state).toBe("ready")
    expect(fresh.some((r) => r.id === data.orgId)).toBe(true)
  })

  it("while builds overlap in a deploy, another build's fresh seeds are left alone and not counted", async () => {
    // A newer process seeded these after this process started, from another world.
    DemoPoolTestAccess.setWorld("world-newer")
    env.LIAISON_VERSION = "build-newer"
    await refillDemoPool()
    DemoPoolTestAccess.setWorld("world-current")
    env.LIAISON_VERSION = "build-current"
    expect(await demoPoolDepth()).toMatchObject({ ready: 0, seeding: 0 })
    env.LIAISON_DEMO_POOL_SIZE = 1
    await refillDemoPool()
    const rows = await pooledBuilds()
    expect(rows.filter((r) => r.build === "build-newer")).toHaveLength(3)
    expect(rows.filter((r) => r.build === "build-current")).toHaveLength(1)
  })

  it("without a build id every pooled workspace is claimable, as before", async () => {
    env.LIAISON_VERSION = "dev"
    await refillDemoPool()
    expect((await pooledBuilds()).map((r) => r.build)).toEqual([null, null, null])
    // A marker some build stamped is still the pool's when the runtime has none.
    const [first] = await pooledBuilds()
    await sql`
      UPDATE kernel.organizations
      SET settings = jsonb_set(settings, '{demo,build}', '"some-build"')
      WHERE id = ${first?.id ?? ""}`
    invalidateDemoMarker()
    await backdatePool()
    expect(await demoPoolDepth()).toMatchObject({ ready: 3, seeding: 0 })
    expect((await refillDemoPool()).seeded).toBe(0)
    const response = await signup({ name: "Alan Turing", email: "alan@example.com" }, nextPeer())
    const data = await readSignup(response)
    expect(data.state).toBe("ready")
    expect(data.orgId).toBe(first?.id ?? "missing")
  })

  it("size 0 is the signup exactly as before: a new org seeded behind the response", async () => {
    env.LIAISON_DEMO_POOL_SIZE = 0
    expect((await refillDemoPool()).skipped).toBe("disabled")
    expect(await demoPoolDepth()).toMatchObject({ ready: 0, seeding: 0 })

    const response = await signup({ name: "Acme Supplies", email: "acme@example.com" }, nextPeer())
    expect(response.status).toBe(201)
    const data = await readSignup(response)
    expect(data.state).toBe("provisioning")
    expect(data.orgSlug.startsWith("demo-acme-supplies-")).toBe(true)
    expect(kicks).toBe(0)
    expect(fitCalls).toEqual([])
    expect(await redis.get(DemoPoolTestAccess.keys.EMPTY_COUNT_KEY)).toBeNull()
    const agents = await sql<{ handle: string }[]>`
      SELECT handle FROM kernel.agents WHERE org_id = ${data.orgId} AND kind = 'personal'`
    expect(agents.map((a) => a.handle)).toEqual(["@acmes-agent"])
    for (let i = 0; i < 100 && !seededOrgIds.has(data.orgId); i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(seededOrgIds.has(data.orgId)).toBe(true)
  })
  // ── Worlds ───────────────────────────────────────────────────────────────

  /** Run three worlds, as a box with every pack would. */
  function runAllWorlds(sizes: string): void {
    DemoWorldsTestAccess.setSeedable(["products", "saas", "studio"])
    env.LIAISON_DEMO_WORLDS = "products,saas,studio"
    env.LIAISON_DEMO_POOL_SIZES = sizes
  }

  /** Pooled orgs with their world, oldest first. */
  async function pooledWorlds(): Promise<Array<{ id: string; world: string; pool: string }>> {
    return [
      ...(await sql<{ id: string; world: string; pool: string }[]>`
        SELECT id, COALESCE(settings->'demo'->>'worldId', 'products') AS world,
          settings->'demo'->>'pool' AS pool
        FROM kernel.organizations WHERE settings->'demo'->>'pool' IS NOT NULL
        ORDER BY created_at ASC`),
    ]
  }

  it("pool sizes split 5 as 2, 2, 1 over three enabled worlds and give 0 to a disabled one", () => {
    env.LIAISON_DEMO_POOL_SIZE = 5
    runAllWorlds("")
    expect(demoPoolTargets()).toEqual({ products: 2, saas: 2, studio: 1 })
    // An explicit split wins, and a world it leaves out keeps none.
    env.LIAISON_DEMO_POOL_SIZES = "products=1,saas=3"
    expect(demoPoolTargets()).toEqual({ products: 1, saas: 3, studio: 0 })
    // A world the box does not run keeps none, whatever the split says.
    env.LIAISON_DEMO_WORLDS = "products,saas"
    env.LIAISON_DEMO_POOL_SIZES = "products=2,saas=2,studio=1"
    expect(demoPoolTargets()).toEqual({ products: 2, saas: 2, studio: 0 })
    env.LIAISON_DEMO_POOL_SIZES = ""
    expect(demoPoolTargets()).toEqual({ products: 3, saas: 2, studio: 0 })
    // Without the packs, only the default world runs and takes the whole size.
    DemoWorldsTestAccess.setSeedable(null)
    env.LIAISON_DEMO_WORLDS = "products,studio"
    expect(demoPoolTargets()).toEqual({ products: 5, saas: 0, studio: 0 })
  })

  it("refill seeds the world missing the most first", async () => {
    // products already full: two of two ready.
    runAllWorlds("products=2")
    expect((await refillDemoPool()).seeded).toBe(2)
    runAllWorlds("products=2,saas=2,studio=1")
    poolSeedWorlds.length = 0
    // One seed at a time, so the order is the refill's choice alone.
    env.LIAISON_DEMO_SEED_CONCURRENCY = 2
    const outcome = await refillDemoPool()
    expect(outcome.order).toEqual(["saas", "studio", "saas"])
    expect(poolSeedWorlds).toEqual(["saas", "studio", "saas"])
    const rows = await pooledWorlds()
    expect(rows.map((r) => r.world)).toEqual(["products", "products", "saas", "studio", "saas"])
    // Each pooled org's marker names its world, and its month for a world that follows it.
    for (const row of rows) {
      const marker = await markerOf(row.id)
      expect(marker.worldId).toBe(row.world)
      if (row.world === "products") expect(marker.worldMonth).toBeUndefined()
      else expect(marker.worldMonth).toMatch(/^\d{4}-\d{2}$/)
    }
  })

  it("the pool's depth and status are reported per world and in total", async () => {
    runAllWorlds("products=1,saas=2,studio=1")
    await refillDemoPool()
    expect(await demoPoolDepth()).toEqual({
      ready: 4,
      seeding: 0,
      worlds: {
        products: { ready: 1, seeding: 0 },
        saas: { ready: 2, seeding: 0 },
        studio: { ready: 1, seeding: 0 },
      },
    })
    const status = await readDemoPoolStatus()
    expect(status?.after.ready).toBe(4)
    expect(status?.after.worlds.saas).toEqual({ ready: 2, seeding: 0 })
    expect(["products", "saas", "studio"]).toContain(status?.worldId ?? "")
  })

  it("one world failing to seed backs off alone while the others refill", async () => {
    runAllWorlds("products=2,saas=2")
    failWorld = "saas"
    const outcome = await refillDemoPool()
    expect(outcome.failed).toBe(1)
    expect(outcome.seeded).toBe(2)
    const backoff = JSON.parse(
      (await redis.get(DemoPoolTestAccess.keys.backoffKey("saas"))) ?? "{}",
    )
    expect(backoff).toMatchObject({ worldId: "saas", failures: 1 })
    expect(await redis.get(DemoPoolTestAccess.keys.backoffKey("products"))).toBeNull()
    expect(await demoPoolDepth()).toMatchObject({
      worlds: { products: { ready: 2 }, saas: { ready: 0 } },
    })
    // Every world short is backing off: the run says so and seeds nothing.
    await sql`
      UPDATE kernel.organizations
      SET settings = jsonb_set(settings, '{demo,expiresAt}', '"2000-01-01T01:00:00.000Z"') #- '{demo,pool}'
      WHERE settings->'demo'->>'pool' IS NOT NULL AND settings->'demo'->>'worldId' = 'saas'`
    invalidateDemoMarker()
    poolSeedCalls = 0
    expect((await refillDemoPool()).skipped).toBe("backoff")
    expect(poolSeedCalls).toBe(0)
  })

  it("a pooled software org from last month is refused and retired", async () => {
    runAllWorlds("products=1,saas=2")
    await refillDemoPool()
    const saas = (await pooledWorlds()).filter((r) => r.world === "saas")
    expect(saas).toHaveLength(2)
    // Both seeded at 23:50 on 30 November, Paris time (UTC+1).
    const seededAt = Date.parse("2026-11-30T22:50:00.000Z")
    await sql`
      UPDATE kernel.organizations
      SET settings = jsonb_set(jsonb_set(settings, '{demo,createdAt}', '"2026-11-30T22:50:00.000Z"'),
        '{demo,worldMonth}', '"2026-11"')
      WHERE id IN ${sql(saas.map((r) => r.id))}`
    invalidateDemoMarker()
    const ask = (at: number) =>
      claimPooledOrg({
        worldId: "saas",
        name: "Night Owl",
        locale: "en",
        needs: ["support"],
        now: new Date(at),
      })

    // 23:55 Paris, still November: claimed, and the visitor's marker keeps the month.
    const before = await ask(seededAt + 5 * 60_000)
    expect(saas.map((r) => r.id)).toContain(before?.orgId ?? "none")
    expect(before?.marker.worldId).toBe("saas")
    expect(before?.marker.worldMonth).toBe("2026-11")

    // 00:10 Paris on 1 December: last month's org is refused...
    const after = seededAt + 20 * 60_000
    expect(await ask(after)).toBeNull()
    expect(await demoPoolDepth(after)).toMatchObject({ worlds: { saas: { ready: 0 } } })
    // ...and the next refill retires it to the reaper.
    const left = saas.find((r) => r.id !== before?.orgId)?.id ?? "missing"
    await refillDemoPool(() => after)
    const marker = await markerOf(left)
    expect(marker.pool).toBeUndefined()
    expect(Date.parse(String(marker.expiresAt))).toBeLessThan(Date.now())
  })

  it("a pooled org older than the maximum age is refused and retired, in every world", async () => {
    env.LIAISON_DEMO_POOL_SIZE = 1
    await refillDemoPool()
    const [row] = await pooledWorlds()
    const thirteenHoursAgo = JSON.stringify(new Date(Date.now() - 13 * 3600_000).toISOString())
    await sql`
      UPDATE kernel.organizations
      SET settings = jsonb_set(settings, '{demo,createdAt}', ${thirteenHoursAgo}::jsonb)
      WHERE id = ${row?.id ?? ""}`
    invalidateDemoMarker()
    expect(
      await claimPooledOrg({ worldId: "products", name: "Late", locale: "en", needs: ["support"] }),
    ).toBeNull()
    expect(await demoPoolDepth()).toMatchObject({ ready: 0, seeding: 0 })
    expect((await refillDemoPool()).seeded).toBe(1)
    expect((await markerOf(row?.id ?? "")).pool).toBeUndefined()
  })

  it("an edit to one world's pack retires that world's ready orgs and keeps the others claimable", async () => {
    runAllWorlds("products=1,saas=1")
    env.LIAISON_VERSION = "build-old"
    DemoPoolTestAccess.setWorld("products-world")
    DemoPoolTestAccess.setWorld("saas-world-old", "saas")
    await refillDemoPool()
    const old = await pooledWorlds()
    await backdatePool()
    // The new build changed the saas pack only.
    env.LIAISON_VERSION = "build-new"
    DemoPoolTestAccess.setWorld("saas-world-new", "saas")
    expect(await demoPoolDepth()).toMatchObject({
      worlds: { products: { ready: 1 }, saas: { ready: 0 } },
    })
    const outcome = await refillDemoPool()
    expect(outcome.order).toEqual(["saas"])
    const kept = old.find((r) => r.world === "products")?.id ?? "missing"
    const gone = old.find((r) => r.world === "saas")?.id ?? "missing"
    expect((await markerOf(kept)).pool).toBe("ready")
    expect((await markerOf(gone)).pool).toBeUndefined()
  })

  it("a world the box stops running retires its pooled orgs", async () => {
    runAllWorlds("products=1,saas=1")
    await refillDemoPool()
    const saasOrg = (await pooledWorlds()).find((r) => r.world === "saas")?.id ?? "missing"
    await backdatePool()
    env.LIAISON_DEMO_WORLDS = "products"
    expect(
      await claimPooledOrg({ worldId: "saas", name: "Off", locale: "en", needs: ["support"] }),
    ).toBeNull()
    await refillDemoPool()
    expect((await markerOf(saasOrg)).pool).toBeUndefined()
  })
})
