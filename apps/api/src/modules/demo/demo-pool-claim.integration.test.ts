// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The warm pool's claim across demo worlds (demo-pool.ts, WORLDS), against the
// real database: a claim asks for one world and can only ever take an org of
// that world, even when an older org of another world is ready, even when two
// claims of two worlds race, and even when its own world's pool is empty.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { DemoWorldId } from "@liaison/shared"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker } from "~/modules/demo/demo-org"
import {
  claimPooledOrg,
  DEMO_POOL_OWNER_NAME,
  DemoPoolTestAccess,
  recordDemoPoolMiss,
  refillDemoPool,
} from "~/modules/demo/demo-pool"
import { DemoSeedGateTestAccess } from "~/modules/demo/demo-seed-gate"
import { DemoSeederTestAccess, setDemoSeeder } from "~/modules/demo/demo-seeder"
import { DemoWorldsTestAccess } from "~/modules/demo/demo-worlds"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const saved = {
  size: env.LIAISON_DEMO_POOL_SIZE,
  sizes: env.LIAISON_DEMO_POOL_SIZES,
  worlds: env.LIAISON_DEMO_WORLDS,
  concurrency: env.LIAISON_DEMO_SEED_CONCURRENCY,
  version: env.LIAISON_VERSION,
}

async function drainPool(): Promise<void> {
  await sql`
    UPDATE kernel.organizations
    SET settings = jsonb_set(settings #- '{demo,pool}', '{demo,expiresAt}', '"2000-01-01T01:00:00.000Z"')
    WHERE settings->'demo'->>'pool' IS NOT NULL`
  invalidateDemoMarker()
}

/** Ready pooled orgs with the world the pool seeded them as, oldest first. */
async function readyByWorld(): Promise<Array<{ id: string; world: string }>> {
  return [
    ...(await sql<{ id: string; world: string }[]>`
      SELECT id, COALESCE(settings->'demo'->>'worldId', 'products') AS world
      FROM kernel.organizations WHERE settings->'demo'->>'pool' = 'ready'
      ORDER BY created_at ASC, id ASC`),
  ]
}

function claim(worldId: DemoWorldId, name: string) {
  return claimPooledOrg({ worldId, name, locale: "en", needs: ["support"] })
}

describe("claiming a pooled workspace of one world", () => {
  beforeAll(async () => {
    await acquireTestLock()
    DemoModeTestAccess.set(true)
    DemoSeedGateTestAccess.setPollMs(10)
    DemoPoolTestAccess.setKick(async () => {})
    // Stands in for the seed: an org of the asked world, nothing in it.
    setDemoSeeder(async ({ orgSlug, owner }) => {
      const [row] = await sql<{ id: string }[]>`
        SELECT id FROM kernel.organizations WHERE slug = ${orgSlug}`
      expect(owner?.name).toBe(DEMO_POOL_OWNER_NAME)
      return { ok: true, orgId: row?.id }
    })
  })

  afterAll(async () => {
    await drainPool()
    env.LIAISON_DEMO_POOL_SIZE = saved.size
    env.LIAISON_DEMO_POOL_SIZES = saved.sizes
    env.LIAISON_DEMO_WORLDS = saved.worlds
    env.LIAISON_DEMO_SEED_CONCURRENCY = saved.concurrency
    env.LIAISON_VERSION = saved.version
    DemoWorldsTestAccess.setSeedable(null)
    DemoSeedGateTestAccess.setPollMs(250)
    DemoPoolTestAccess.setKick(null)
    DemoModeTestAccess.set(null)
    DemoSeederTestAccess.reset()
    await releaseTestLock()
  })

  beforeEach(async () => {
    await drainPool()
    await clearRedisPatterns(["demo:*"])
    DemoWorldsTestAccess.setSeedable(["products", "saas", "studio"])
    env.LIAISON_DEMO_WORLDS = "products,saas"
    env.LIAISON_VERSION = "dev"
    // One seed at a time: the pool's orgs are made products, saas, products, saas.
    env.LIAISON_DEMO_SEED_CONCURRENCY = 2
  })

  it("two concurrent claims of two worlds never exchange orgs", async () => {
    // The saas orgs first, so the oldest ready org is one of theirs: a
    // products claim that ignored the world would take it.
    env.LIAISON_DEMO_POOL_SIZES = "saas=3"
    expect((await refillDemoPool()).seeded).toBe(3)
    env.LIAISON_DEMO_POOL_SIZES = "products=3,saas=3"
    expect((await refillDemoPool()).seeded).toBe(3)
    const pooled = await readyByWorld()
    expect(pooled.map((r) => r.world)).toEqual([
      "saas",
      "saas",
      "saas",
      "products",
      "products",
      "products",
    ])
    const worldOf = new Map(pooled.map((r) => [r.id, r.world]))

    for (let round = 0; round < 3; round++) {
      // Both claims start together, the products one first, on two connections.
      const [products, saas] = await Promise.all([
        claim("products", `Products visitor ${round}`),
        claim("saas", `Saas visitor ${round}`),
      ])
      expect(saas).not.toBeNull()
      expect(products).not.toBeNull()
      expect(worldOf.get(saas?.orgId ?? "")).toBe("saas")
      expect(worldOf.get(products?.orgId ?? "")).toBe("products")
      expect(saas?.marker.worldId).toBe("saas")
      expect(products?.marker.worldId).toBe("products")
      // The row says the same as the claim's answer.
      const rows = await sql<{ id: string; world: string }[]>`
        SELECT id, settings->'demo'->>'worldId' AS world FROM kernel.organizations
        WHERE id IN ${sql([saas?.orgId ?? "", products?.orgId ?? ""])}`
      for (const row of rows) expect(row.world).toBe(worldOf.get(row.id) ?? "missing")
    }
    // Every org was handed out once, each to its own world's claim.
    expect(await readyByWorld()).toEqual([])
    expect(await claim("saas", "One too many")).toBeNull()
  })

  it("retiring a workspace a visitor already claimed leaves the visitor's marker alone", async () => {
    env.LIAISON_DEMO_POOL_SIZES = "saas=2"
    expect((await refillDemoPool()).seeded).toBe(2)
    const [first, second] = await readyByWorld()
    // Another process claims one for a visitor after this one read it as pooled.
    const taken = await claim("saas", "Claimed visitor")
    expect(taken?.orgId).toBe(first?.id ?? "none")
    const markerOf = async (id: string) =>
      (
        await sql<{ demo: Record<string, unknown> }[]>`
          SELECT settings->'demo' AS demo FROM kernel.organizations WHERE id = ${id}`
      )[0]?.demo ?? {}
    const claimed = await markerOf(taken?.orgId ?? "")
    expect(await DemoPoolTestAccess.retirePooledOrg(taken?.orgId ?? "")).toBe(false)
    const after = await markerOf(taken?.orgId ?? "")
    expect(after).toEqual(claimed)
    expect(Date.parse(String(after.expiresAt))).toBeGreaterThan(Date.now())

    // A workspace still in the pool is retired: out of the pool, already expired.
    expect(await DemoPoolTestAccess.retirePooledOrg(second?.id ?? "")).toBe(true)
    const retired = await markerOf(second?.id ?? "")
    expect(retired.pool).toBeUndefined()
    expect(Date.parse(String(retired.expiresAt))).toBeLessThan(Date.now())
  })

  it("with no warm org of the asked world the claim returns none and logs the miss with its world", async () => {
    // Ready saas orgs, none of products: the products claim takes nothing.
    env.LIAISON_DEMO_POOL_SIZES = "saas=2"
    expect((await refillDemoPool()).seeded).toBe(2)
    const saasOnly = await readyByWorld()
    expect(saasOnly.map((r) => r.world)).toEqual(["saas", "saas"])
    expect(await claim("products", "Products visitor")).toBeNull()
    expect(await readyByWorld()).toEqual(saasOnly)
    await drainPool()

    env.LIAISON_DEMO_POOL_SIZES = "products=2"
    expect((await refillDemoPool()).seeded).toBe(2)
    const before = await readyByWorld()
    expect(before.map((r) => r.world)).toEqual(["products", "products"])

    // Ready products orgs, none of saas: the saas claim takes nothing.
    expect(await claim("saas", "Software visitor")).toBeNull()
    expect(await readyByWorld()).toEqual(before)
    // A world the box does not run is never claimed either.
    expect(await claim("studio", "Studio visitor")).toBeNull()
    expect(await readyByWorld()).toEqual(before)

    const lines: Array<{ msg: string; fields: Record<string, unknown> }> = []
    const original = rootLogger.warn.bind(rootLogger)
    ;(rootLogger as unknown as { warn: unknown }).warn = (first: unknown, second?: unknown) => {
      if (typeof first === "object" && first !== null && typeof second === "string") {
        lines.push({ msg: second, fields: first as Record<string, unknown> })
      }
      return original(first as object, second as string)
    }
    try {
      await recordDemoPoolMiss("saas")
    } finally {
      ;(rootLogger as unknown as { warn: unknown }).warn = original
    }
    const miss = lines.find((l) => l.fields.alert === "demo_pool_empty")
    expect(miss?.fields.worldId).toBe("saas")
    expect(miss?.fields.worldEmptyClaims).toBe(1)
    expect(Number(await redis.get(`${DemoPoolTestAccess.keys.EMPTY_COUNT_KEY}:saas`))).toBe(1)

    // The products pool is untouched and still serves its own world.
    const taken = await claim("products", "Products visitor")
    expect(before.map((r) => r.id)).toContain(taken?.orgId ?? "none")
  })
})
