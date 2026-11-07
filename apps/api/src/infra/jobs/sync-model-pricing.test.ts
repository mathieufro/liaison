// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from "bun:test"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { modelPricing } from "~/db/schema/kernel"
import { jobsLogger } from "~/lib/logger"

let syncModelPricing: typeof import("./sync-model-pricing").syncModelPricing

// Mock fetch globally
const originalFetch = globalThis.fetch

beforeAll(async () => {
  const mod = await import("./sync-model-pricing")
  syncModelPricing = mod.syncModelPricing

  // Seed a model with source = 'litellm_sync' for update testing
  await withSystemDb("test-seed-sync", async (tx) => {
    await tx
      .insert(modelPricing)
      .values({
        provider: "anthropic",
        modelId: "sync-test-model",
        displayName: "Sync Test",
        inputCostPerM: "1.00000000",
        outputCostPerM: "2.00000000",
        contextWindow: 100000,
        source: "litellm_sync",
      })
      .onConflictDoNothing()

    await tx
      .insert(modelPricing)
      .values({
        provider: "openai",
        modelId: "manual-test-model",
        displayName: "Manual Test",
        inputCostPerM: "3.00000000",
        outputCostPerM: "4.00000000",
        contextWindow: 50000,
        source: "manual",
      })
      .onConflictDoNothing()
  })
})

afterAll(async () => {
  globalThis.fetch = originalFetch
  await sql`DELETE FROM kernel.model_pricing WHERE model_id IN ('sync-test-model', 'manual-test-model')`
  await sql`DELETE FROM kernel.system_config WHERE key = 'usd_eur_rate'`
})

describe("syncModelPricing", () => {
  it("fetches ECB rate and persists to system_config", async () => {
    const mockEcbResponse = {
      dataSets: [
        {
          series: {
            "0:0:0:0:0": {
              observations: { "0": [1.15] },
            },
          },
        },
      ],
    }

    const mockLitellmResponse = {
      "sync-test-model": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        max_input_tokens: 200000,
        mode: "chat",
      },
    }

    globalThis.fetch = mock((url: string) => {
      if (url.includes("ecb.europa.eu")) {
        return Promise.resolve(new Response(JSON.stringify(mockEcbResponse), { status: 200 }))
      }
      if (url.includes("litellm")) {
        return Promise.resolve(new Response(JSON.stringify(mockLitellmResponse), { status: 200 }))
      }
      return Promise.resolve(new Response("", { status: 404 }))
    }) as any

    await syncModelPricing()

    const [rate] = await sql`SELECT * FROM kernel.system_config WHERE key = 'usd_eur_rate'`
    expect(rate).toBeDefined()
    expect(rate.value.rate).toBe(1.15)
  })

  it("updates litellm_sync models with new prices", async () => {
    const mockEcbResponse = {
      dataSets: [
        {
          series: {
            "0:0:0:0:0": {
              observations: { "0": [1.15] },
            },
          },
        },
      ],
    }

    const mockLitellmResponse = {
      "sync-test-model": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        max_input_tokens: 200000,
        mode: "chat",
      },
    }

    globalThis.fetch = mock((url: string) => {
      if (url.includes("ecb.europa.eu")) {
        return Promise.resolve(new Response(JSON.stringify(mockEcbResponse), { status: 200 }))
      }
      if (url.includes("litellm")) {
        return Promise.resolve(new Response(JSON.stringify(mockLitellmResponse), { status: 200 }))
      }
      return Promise.resolve(new Response("", { status: 404 }))
    }) as any

    await syncModelPricing()

    const [model] = await sql`SELECT * FROM kernel.model_pricing WHERE model_id = 'sync-test-model'`
    // input: 0.000003 * 1_000_000 / 1.15 ≈ 2.6087...
    expect(Number(model.input_cost_per_m)).toBeCloseTo(2.6087, 2)
    expect(model.context_window).toBe(200000)
  })

  it("does NOT update manual source models", async () => {
    const [model] =
      await sql`SELECT * FROM kernel.model_pricing WHERE model_id = 'manual-test-model'`
    expect(model.input_cost_per_m).toBe("3.00000000")
    expect(model.output_cost_per_m).toBe("4.00000000")
  })

  it("uses last-known rate when ECB fetch fails", async () => {
    // First, ensure a rate exists
    await sql`INSERT INTO kernel.system_config (key, value) VALUES ('usd_eur_rate', '{"rate": 1.12, "fetchedAt": "2026-04-05T00:00:00Z"}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`

    globalThis.fetch = mock((url: string) => {
      if (url.includes("ecb.europa.eu")) {
        return Promise.reject(new Error("ECB down"))
      }
      if (url.includes("litellm")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              "sync-test-model": {
                input_cost_per_token: 0.000003,
                output_cost_per_token: 0.000015,
                max_input_tokens: 200000,
                mode: "chat",
              },
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response("", { status: 404 }))
    }) as any

    await syncModelPricing()

    // Should have used the 1.12 rate, not 1.15
    const [model] = await sql`SELECT * FROM kernel.model_pricing WHERE model_id = 'sync-test-model'`
    // input: 0.000003 * 1_000_000 / 1.12 ≈ 2.6786
    expect(Number(model.input_cost_per_m)).toBeCloseTo(2.6786, 2)
  })

  it("skips price sync entirely when LiteLLM fetch fails", async () => {
    // Record current prices
    const [before] =
      await sql`SELECT input_cost_per_m FROM kernel.model_pricing WHERE model_id = 'sync-test-model'`

    globalThis.fetch = mock((url: string) => {
      if (url.includes("ecb.europa.eu")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              dataSets: [{ series: { "0:0:0:0:0": { observations: { "0": [1.15] } } } }],
            }),
            { status: 200 },
          ),
        )
      }
      if (url.includes("litellm")) {
        return Promise.reject(new Error("GitHub down"))
      }
      return Promise.resolve(new Response("", { status: 404 }))
    }) as any

    await syncModelPricing()

    const [after] =
      await sql`SELECT input_cost_per_m FROM kernel.model_pricing WHERE model_id = 'sync-test-model'`
    expect(after.input_cost_per_m).toBe(before.input_cost_per_m)
  })
})

// Under SCHEMA_PREFIX (every e2e and Playwright server) the job's raw SQL must hit
// the prefixed kernel tables, the same ones its Drizzle queries use in such a
// deployment. Scratch `smpfx_kernel` copies hold rows that exist ONLY there; a
// fixed `kernel.` writes the rate into the base table and scans the base table
// for staleness, and fails both assertions. The prefix is flipped only around
// the job call (`schemaRef` reads it at call time).
describe("syncModelPricing under a schema prefix uses the prefixed kernel tables", () => {
  const PREFIX = "smpfx_"
  const K = `${PREFIX}kernel`

  async function withPrefix<T>(fn: () => Promise<T>): Promise<T> {
    const prior = process.env.SCHEMA_PREFIX
    process.env.SCHEMA_PREFIX = PREFIX
    try {
      return await fn()
    } finally {
      if (prior === undefined) delete process.env.SCHEMA_PREFIX
      else process.env.SCHEMA_PREFIX = prior
    }
  }

  function mockFeeds(ecbRate: number) {
    globalThis.fetch = mock((url: string) => {
      if (url.includes("ecb.europa.eu")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              dataSets: [{ series: { "0:0:0:0:0": { observations: { "0": [ecbRate] } } } }],
            }),
            { status: 200 },
          ),
        )
      }
      // An empty catalogue: the sync step matches nothing, the staleness scan still runs.
      if (url.includes("litellm")) {
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
      }
      return Promise.resolve(new Response("", { status: 404 }))
    }) as any
  }

  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${K} CASCADE`)
    await sql.unsafe(`CREATE SCHEMA ${K}`)
    await sql.unsafe(`GRANT USAGE ON SCHEMA ${K} TO liaison_rls, liaison_app, liaison_admin`)
    // INCLUDING ALL keeps the key constraint the rate upsert's ON CONFLICT needs.
    await sql.unsafe(`CREATE TABLE ${K}.system_config (LIKE kernel.system_config INCLUDING ALL)`)
    await sql.unsafe(
      `CREATE TABLE ${K}.model_pricing (LIKE kernel.model_pricing INCLUDING DEFAULTS)`,
    )
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE ON ${K}.system_config, ${K}.model_pricing TO liaison_rls, liaison_app, liaison_admin`,
    )
    await sql.unsafe(
      `INSERT INTO ${K}.model_pricing
         (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, source, updated_at)
       VALUES ('anthropic', 'prefixed-stale-model', 'Prefixed Stale', '1.00000000', '2.00000000', 100000,
               'litellm_sync', now() - interval '30 days')`,
    )
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${K} CASCADE`)
  })

  it("writes the fetched ECB rate into the prefixed system_config, not the base table", async () => {
    await sql`INSERT INTO kernel.system_config (key, value) VALUES ('usd_eur_rate', '{"rate": 9.99, "fetchedAt": "2026-01-01T00:00:00Z"}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    mockFeeds(1.31)

    await withPrefix(() => syncModelPricing())

    const [prefixed] = await sql.unsafe(
      `SELECT value FROM ${K}.system_config WHERE key = 'usd_eur_rate'`,
    )
    expect(prefixed?.value?.rate).toBe(1.31)
    const [base] = await sql`SELECT value FROM kernel.system_config WHERE key = 'usd_eur_rate'`
    expect(base.value.rate).toBe(9.99)
  })

  it("reports staleness from the prefixed model_pricing", async () => {
    mockFeeds(1.31)
    // On the logger itself: a spy restored on it by another file leaves an own `warn` that a
    // spy on its prototype would never see.
    const warnSpy = spyOn(jobsLogger, "warn")
    try {
      await withPrefix(() => syncModelPricing())
      const staleModelIds = warnSpy.mock.calls
        .filter((call) => call[1] === "Model pricing is stale (>7 days)")
        .map((call) => (call[0] as { modelId?: string }).modelId)
      expect(staleModelIds).toContain("prefixed-stale-model")
    } finally {
      warnSpy.mockRestore()
    }
  })
})
